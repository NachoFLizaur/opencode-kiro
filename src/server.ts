// Server plugin: setup composition. Registers the Integration/auth flow, the
// provider transform + discovery lifecycle, the logout detector, the retry
// guard, and the AISDK hooks over one per-location ServerState with an
// aggregated cleanup (src/server/lifecycle.ts).
//
// Installed-types note: `@opencode/plugin` (root promise export) namespaces its
// types as `Plugin.Plugin` / `Plugin.Context` / `Plugin.Cleanup` via
// `export * as Plugin from "./plugin.js"`.
import type { Plugin } from "@opencode/plugin"
import { registerAisdkHook } from "./server/aisdk.js"
import { registerAuth } from "./server/auth.js"
import { KIRO_PROVIDER_ID, type KiroPluginOptions, registerDiscovery } from "./server/discovery.js"
import { buildCleanup, createServerState } from "./server/lifecycle.js"
import { createLogoutDetector, registerLogoutDetector } from "./server/logout.js"
import { createRetryGuard, registerRetryGuard } from "./server/retry.js"

// Plugin options apply to configured npm and local-directory plugins;
// bundled/builtin plugins receive {}.
// Some hosts omit `context.options` entirely, so the ?? {} guard at the call
// site is required. No `cwd` option by design — the per-location
// integration.list() derivation is strictly better (discovery.ts).
//
// Exactly four options: `agent` (default "opencode"), `mcpTimeout` (default
// 45, must be a positive finite number of minutes), `discover` (default true),
// and `stall` (no default: the SDK's stall watchdog defaults apply when it is
// absent). `stall` is an object with optional `afterMs` (finite number >= 0,
// where 0 disables the watchdog) and `live` ("off" | "reasoning"); invalid
// members are dropped individually and an object left empty is treated as
// absent. Type-invalid values fall back to the defaults and unknown keys are
// ignored silently (fail open). `trustAllTools` is not exposed.
function resolveOptions(raw: Record<string, unknown>): KiroPluginOptions {
  const stall = resolveStall(raw.stall)
  return {
    agent: typeof raw.agent === "string" && raw.agent !== "" ? raw.agent : "opencode",
    mcpTimeout:
      typeof raw.mcpTimeout === "number" && Number.isFinite(raw.mcpTimeout) && raw.mcpTimeout > 0
        ? raw.mcpTimeout
        : 45,
    discover: typeof raw.discover === "boolean" ? raw.discover : true,
    ...(stall !== undefined ? { stall } : {}),
  }
}

// `stall` option validation (@since 0.5.0-beta.5). Only a plain object is
// accepted; each member is kept only when it matches the SDK type, so a
// partially valid object still forwards its valid members. Returns undefined
// when nothing valid remains, which keeps the key out of the provider settings.
function resolveStall(raw: unknown): KiroPluginOptions["stall"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const { afterMs, live } = raw as Record<string, unknown>
  const stall: NonNullable<KiroPluginOptions["stall"]> = {}
  if (typeof afterMs === "number" && Number.isFinite(afterMs) && afterMs >= 0) stall.afterMs = afterMs
  if (live === "off" || live === "reasoning") stall.live = live
  return Object.keys(stall).length > 0 ? stall : undefined
}

// setup order: resolve plugin options -> build per-location state ->
// registerAuth (Integration `kiro` + Kiro CLI Login OAuth; the transform also
// publishes the logout stage) -> registerDiscovery (captures cwd from
// integration.list().location, registers the provider transform + event
// consumer, kicks off one initial discovery when already connected and
// `discover` is not false) -> registerLogoutDetector (provider-scoped
// `context` session hook probing kiro-cli's auth state) -> registerRetryGuard
// (provider-scoped `retry` session hook that stops retries of not-logged-in
// failures) -> registerAisdkHook (plugin-owned createKiroAcp provider) ->
// return the one aggregated, idempotent cleanup.
//
// The logout detector is built before registerAuth because the login flow
// reports its authenticated observations to it; the detector's own hook is
// registered afterwards and its disposer joins the same ordered list.
//
// Failure path: if any registration throws mid-setup, the partial cleanup runs
// over the disposers registered so far (no leaked registrations) and the
// original setup error is rethrown; cleanup failures during that unwind are
// swallowed so they cannot mask it.
const plugin: Plugin.Plugin = {
  id: "kiro",
  // The host discovers the TUI half from this package's `./tui` export.
  async setup(context: Plugin.Context): Promise<Plugin.Cleanup> {
    // `PluginOptions` is a loose Readonly<Record<string, any>> in the installed
    // d.ts; the runtime typeof checks in resolveOptions are the real guard
    const options = resolveOptions((context.options ?? {}) as Record<string, unknown>)
    const state = createServerState()
    const cleanup = buildCleanup(state)
    const logoutDetector = createLogoutDetector(state.logout, {
      reload: () => context.integration.reload(),
    })

    try {
      state.disposers.push(
        await registerAuth(context, state.auth, state.logout, () => logoutDetector.noteAuthenticated()),
      )
      state.disposers.push(await registerDiscovery(context, state.discovery, options))
      state.disposers.push(await registerLogoutDetector(context, logoutDetector, KIRO_PROVIDER_ID))
      state.disposers.push(await registerRetryGuard(context, createRetryGuard(), KIRO_PROVIDER_ID))
      state.disposers.push(await registerAisdkHook(context, state.aisdk))
    } catch (error) {
      await Promise.resolve(cleanup()).catch(() => {})
      throw error
    }

    return cleanup
  },
}

// default export drives opencode's plugin loader via the `./server` exports
// subpath. The exports map deliberately has no "." key, so there is no root
// fallback.
export default plugin

// named export, same reference as the default so the two can't drift (kept for backward compatibility)
export const KiroAuthPlugin = plugin
