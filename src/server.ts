import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// The plugin name as it appears in the user's tui.json `plugin` array, and the
// builtin TUI sidebar we replace by disabling it in `plugin_enabled`.
const KIRO_PLUGIN_NAME = "opencode-kiro"
const SIDEBAR_PLUGIN_ID = "internal:sidebar-context"

// Auth-only server plugin: the kiro provider/model catalog lives on models.dev,
// so this only supplies the `auth` hook. Must never export `tui` (the loader
// rejects modules exporting both kinds).
//
// EXPERIMENT (experiment/auth-tui-config): on login we OFFER to wire up the
// kiro credits sidebar by writing the user's global tui.json. server(input)
// re-runs on every startup, so we re-check the file each session and only ask
// when it isn't already configured ("don't ask twice", covers re-auth).
const server = async (input: PluginInput): Promise<Hooks> => {
  // Startup login nudge (runs every session): if kiro-cli whoami reports the
  // user is not logged in, surface a non-blocking toast/log telling them to
  // re-auth. This is fully guarded and never throws; a rejection here would
  // become a defect that crashes ALL providers.
  await notifyIfTokenExpired(input.client)

  const tuiPath = tuiConfigPath()
  const alreadyConfigured = isSidebarConfigured(await readTuiConfig(tuiPath))

  // Only OFFER the sidebar when it isn't already set up. When configured, omit
  // the prompt entirely (empty array => the host shows nothing).
  const prompts = alreadyConfigured
    ? []
    : [
        {
          type: "select" as const,
          key: "sidebar",
          message: "Enable the Kiro credits sidebar?",
          options: [
            { label: "Yes", value: "yes", hint: "writes tui.json; restart to apply" },
            { label: "No", value: "no" },
          ],
        },
      ]

  return {
    auth: {
      provider: "kiro",
      // Returned options are forwarded into createKiroAcp({...}). Relays each
      // catalog model's limit.context into contextWindows keyed by api.id;
      // zero/missing limits are skipped (SDK falls back to 1M).
      loader: async (_getAuth, provider) => ({
        cwd: input.directory ?? input.worktree,
        agent: "opencode",
        trustAllTools: true,
        mcpTimeout: 45,
        contextWindows: Object.fromEntries(
          Object.values(provider?.models ?? {})
            .filter((m) => m.api?.id && (m.limit?.context ?? 0) > 0)
            .map((m) => [m.api.id, m.limit.context]),
        ),
      }),
      methods: [
        {
          type: "oauth" as const,
          label: "Kiro CLI Login",
          prompts,
          async authorize(inputs) {
            const { verifyAuth } = await import("kiro-acp-ai-provider")
            const status = verifyAuth()

            if (!status.installed)
              throw new Error(
                "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/",
              )

            // Write the sidebar config only when we actually offered the prompt
            // this session AND the user opted in. Runs after a SUCCESSFUL login.
            const enableSidebar = !alreadyConfigured && inputs?.sidebar === "yes"
            const onSuccess = async () => {
              if (enableSidebar) await enableSidebarConfig(tuiPath, input)
            }

            // Already authed: return immediately
            if (status.authenticated) {
              return {
                url: "",
                instructions: "",
                method: "auto" as const,
                async callback() {
                  const result = await readToken(status.tokenPath)
                  if (result.type === "success") await onSuccess()
                  return result
                },
              }
            }

            // Not authed: launch kiro-cli login and poll
            const { execFile } = await import("node:child_process")
            // shell:true on win32 so the bare "kiro-cli" name resolves via
            // PATHEXT to kiro-cli.exe/.cmd (matches the SDK's own win32-safe
            // spawns). shell:false on macOS/Linux keeps behavior identical.
            const child = execFile("kiro-cli", ["login"], {
              shell: process.platform === "win32",
            })

            return {
              url: "",
              instructions:
                "Complete Kiro authentication in the browser window that just opened. Waiting for login...",
              method: "auto" as const,
              async callback() {
                // Poll until authed (login runs in the background)
                const maxWait = 120_000
                const start = Date.now()
                while (Date.now() - start < maxWait) {
                  await new Promise((r) => setTimeout(r, 2000))
                  const check = verifyAuth()
                  if (check.authenticated) {
                    child.kill()
                    const result = await readToken(check.tokenPath)
                    if (result.type === "success") await onSuccess()
                    return result
                  }
                }
                child.kill()
                throw new Error(
                  "Kiro authentication timed out. Run `kiro-cli login` manually.",
                )
              },
            }
          },
        },
      ],
    },
    // Ensure a kiro provider entry exists so a stored login plus a kiro-less
    // catalog cannot crash opencode (core derefs an undefined provider during
    // auth init). Mutates in place; the ??= keeps it idempotent and never
    // clobbers a real models.dev kiro entry when one is present.
    config: async (input) => {
      input.provider ??= {}
      input.provider.kiro ??= {}
    },
    provider: {
      id: "kiro",
      // Inject per-model reasoning-effort variants, consumed as providerOptions.kiro.reasoningEffort.
      async models(provider, _ctx) {
        const { reasoningEffortsFor } = await import("kiro-acp-ai-provider")
        for (const model of Object.values(provider.models)) {
          // Guard the api.id deref: a malformed catalog entry must not fail provider registration.
          const apiId = model.api?.id
          if (!apiId) continue
          const levels = reasoningEffortsFor(apiId)
          if (levels.length === 0) continue // non-effort models: no variants
          model.variants = Object.fromEntries(
            levels.map((level) => [level, { reasoningEffort: level }]),
          )
        }
        return provider.models
      },
    },
  }
}

// The kiro-cli token file path the SDK reads (~/.aws/sso/cache/kiro-auth-token.json).
// Kept in sync with kiro-acp-ai-provider's verifyAuth() resolution so the startup
// check inspects the SAME file the provider authenticates against.
export function kiroTokenPath(): string {
  return join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
}

// Read+parse the kiro-cli token file. Returns the parsed object, or undefined
// when the file is missing, unreadable, or not a JSON object. Never throws.
async function readKiroTokenFile(
  tokenPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const parsed = JSON.parse(await readFile(tokenPath, "utf8"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// Build opencode's auth record, gated on kiro-cli whoami (verifyAuth), NOT the
// on-disk token file. The file expiresAt is meaningless (kiro-cli does not
// rewrite it on login; the live credential lives in the OS store and whoami
// self-heals), so a stale or missing file MUST NOT refuse a logged-in user.
// On success it emits a FUTURE expires so opencode-core does not flag the
// provider, and carries the file's REAL refresh token when present.
export async function readToken(
  tokenPath: string | undefined,
): Promise<
  | { type: "success"; refresh: string; access: string; expires: number }
  | { type: "failed" }
> {
  // Authority = kiro-cli whoami (abstracts the per-OS credential store).
  const { verifyAuth } = await import("kiro-acp-ai-provider")
  if (!verifyAuth().authenticated) return { type: "failed" as const }

  // Logged in. The cached file is OPTIONAL and only used for the real refresh
  // token / cosmetic access value; a stale or missing file MUST NOT refuse a
  // logged-in user (that was the core bug). Never throws.
  const token = tokenPath ? await readKiroTokenFile(tokenPath) : undefined
  const access = typeof token?.accessToken === "string" ? token.accessToken : ""
  const refresh = typeof token?.refreshToken === "string" ? token.refreshToken : ""

  return {
    type: "success" as const,
    refresh, // real refresh when present, else ""
    access: access || "authenticated", // cosmetic; opencode-core only needs presence
    // FUTURE expiry, refreshed every startup (server() re-runs each session) so
    // opencode-core does not flag a logged-in user as expired. NOT the file value.
    expires: Date.now() + 8 * 60 * 60 * 1000,
  }
}

// Startup login nudge. When kiro-cli whoami (verifyAuth) reports the user is
// NOT logged in, surface a non-blocking nudge telling them to run kiro-cli
// login. The gate is whoami, NOT the on-disk file expiresAt (which is
// meaningless and false-warned on every startup). Because kiro-cli auto-re-
// authenticates, a logged-in user reads authenticated=true and this is silent.
// MUST NEVER throw, reject, OR BLOCK/HANG: the auth loader runs inside an
// Effect.promise, so any rejection becomes a defect that crashes ALL providers,
// and a hang blocks startup for every provider. Every step is guarded.
//
// FINDING F1: the LOG line is emitted FIRST, synchronously, and the toast is
// FIRE-AND-FORGET (never awaited). A HEADLESS (non-TUI) run has no TUI receiver,
// so showToast's promise NEVER resolves; awaiting it hung startup forever (it
// hangs rather than throws, so the old try/catch + .catch() fallback never ran).
// Logging first guarantees headless still gets the message; the toast is a
// best-effort UI enhancement that only matters when a TUI is actually attached.
export async function notifyIfTokenExpired(
  client: PluginInput["client"] | undefined,
): Promise<void> {
  try {
    const { verifyAuth } = await import("kiro-acp-ai-provider")
    if (verifyAuth().authenticated) return // logged in per whoami: no nudge

    const message = "Kiro is not logged in. Run 'kiro-cli login' to authenticate."

    // 1) LOG FIRST: synchronous + reliable. The only channel guaranteed to reach
    //    a headless (non-TUI) run, which has no receiver for a toast.
    console.warn(message)

    // 2) Toast is FIRE-AND-FORGET: do NOT await it. With no TUI attached the
    //    promise never settles; awaiting it would hang startup (finding F1).
    void client?.tui?.showToast?.({ body: { message, variant: "warning" } })?.catch(() => {})
  } catch {
    // Never rethrow: a rejection here becomes a defect that crashes all providers.
  }
}

// Global tui.json location: $XDG_CONFIG_HOME/opencode/tui.json, else
// ~/.config/opencode/tui.json. Mirrors opencode's own config resolution so the
// toggle lands where the TUI actually reads it.
function tuiConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "tui.json")
}

// Read+parse the global tui.json. Returns the object, or undefined when the file
// is missing or unparseable (either way: treat as "not configured").
async function readTuiConfig(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const parsed = JSON.parse(await readFile(path, "utf8"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// "Already configured" = opencode-kiro is in `plugin` AND the builtin sidebar is
// disabled via plugin_enabled (so the kiro credits sidebar replaces it).
function isSidebarConfigured(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false
  const plugin = config.plugin
  const enabled = config.plugin_enabled
  const hasPlugin = Array.isArray(plugin) && plugin.includes(KIRO_PLUGIN_NAME)
  const sidebarOff =
    typeof enabled === "object" &&
    enabled !== null &&
    (enabled as Record<string, unknown>)[SIDEBAR_PLUGIN_ID] === false
  return hasPlugin && sidebarOff
}

// Idempotently merge the credits-sidebar config into the global tui.json after a
// successful login. Defensive + non-destructive: starts from {} when the file is
// missing, bails (no write) when it exists but is unparseable, preserves all
// other keys, and NEVER throws: a config-write failure must not fail auth.
async function enableSidebarConfig(path: string, input: PluginInput): Promise<void> {
  try {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises")

    // Read the raw file separately from parsing so we can tell "missing" (start
    // fresh from {}) apart from "exists but unparseable" (don't clobber).
    let raw: string | undefined
    try {
      raw = await readFile(path, "utf8")
    } catch {
      raw = undefined
    }

    let config: Record<string, unknown>
    if (raw === undefined) {
      config = {}
    } else {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
        config = parsed as Record<string, unknown>
      } catch {
        // File exists but is unparseable: skip the write, don't clobber it.
        return
      }
    }

    // Idempotent: already wired up, nothing to do.
    if (isSidebarConfigured(config)) return

    // Ensure opencode-kiro is in `plugin` (create + dedup); preserve any others.
    const plugin = Array.isArray(config.plugin) ? [...(config.plugin as unknown[])] : []
    if (!plugin.includes(KIRO_PLUGIN_NAME)) plugin.push(KIRO_PLUGIN_NAME)
    config.plugin = plugin

    // Disable the builtin sidebar; preserve any other plugin_enabled entries.
    const enabled =
      typeof config.plugin_enabled === "object" &&
      config.plugin_enabled !== null &&
      !Array.isArray(config.plugin_enabled)
        ? (config.plugin_enabled as Record<string, unknown>)
        : {}
    enabled[SIDEBAR_PLUGIN_ID] = false
    config.plugin_enabled = enabled

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8")

    // Best-effort UX notice: only renders if a TUI is attached, harmless if not.
    try {
      await input.client.tui.showToast({
        body: {
          message: "Kiro credits sidebar enabled. Restart opencode to see it.",
          variant: "success",
        },
      })
    } catch {
      // No TUI / toast unavailable: ignore.
    }
  } catch {
    // Never let a config-write error break a successful auth.
  }
}

// Named export for bundling: same function reference as the default's `server`,
// so the two can't drift. Lets opencode do `import { KiroAuthPlugin }`, matching
// GitlabAuthPlugin/PoeAuthPlugin/CopilotAuthPlugin.
export const KiroAuthPlugin: Plugin = server

// Default export drives opencode's external plugin loader, which reads `default`.
export default { id: "kiro", server }
