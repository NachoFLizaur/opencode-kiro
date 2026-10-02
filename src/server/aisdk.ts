// AISDK `sdk` + `language` hooks: one plugin-owned Kiro provider per distinct
// configuration, shared across effort variants.
//
// The host may already have populated `event.sdk` with an unowned provider, so
// the `sdk` hook always overwrites it with its own `createKiroAcp(settings)`
// instance. The host also injects a non-serializable `fetch` into
// `event.options`, so settings are allowlist-sanitized before keying, and the
// same sanitized object reaches the factory. `effort`/`efforts` stay out of
// the settings so one provider serves every effort; effort travels per request
// through the `language` hook's `languageModel(id, { effort })` override. Every
// owned instance is `shutdown()` exactly once from the aggregated cleanup.
// The SDK import stays lazy so dist/server.js loads under plain Node.
import type { Model, Plugin } from "@opencode/plugin"
import type { KiroACPModelOverrides, KiroACPProvider, KiroACPProviderSettings } from "kiro-acp-ai-provider"
// NAMED import on purpose: esbuild converts top-level JSON properties into
// named exports and tree-shakes the rest, so dist/server.js inlines only the
// version string (a default import would inline the whole package.json,
// including dependency names the packaging tests reject).
import { version as PKG_VERSION } from "../../package.json"
import { KIRO_PROVIDER_ID } from "./discovery.js"

// bare package name — core normalizes `Provider.Info.package`
// ("aisdk:kiro-acp-ai-provider") to the package name for the SDK event
export const KIRO_SDK_PACKAGE = "kiro-acp-ai-provider"

// process-constant client identification forwarded to kiro-cli's ACP
// initialize (KiroACPProviderSettings.clientInfo). Never per-request or
// timestamp-like, so it participates in the cache key harmlessly. The version
// is inlined from package.json at build time (tsup/esbuild JSON import), so
// dist/server.js stays free of runtime file reads.
const CLIENT_INFO = { name: "opencode-kiro", version: PKG_VERSION } as const

// structural mirror of the installed d.ts `AISDKHooks["sdk"]` event
// (dist/promise/aisdk.d.ts) — AISDKHooks is not exported from the package
// root, so a local alias that stays assignable to it is kept here.
type SdkHookEvent = {
  readonly model: Model.Info
  readonly package: string
  readonly options: Record<string, unknown>
  sdk?: unknown
}

// structural mirror of the installed d.ts `AISDKHooks["language"]` event
// (dist/promise/aisdk.d.ts) — same local-alias pattern as SdkHookEvent.
// `language` is typed `unknown` here (host: LanguageModelV3) so this module
// does not import @ai-sdk/provider types directly.
type LanguageHookEvent = {
  readonly model: Model.Info
  readonly sdk: unknown
  readonly options: Record<string, unknown>
  language?: unknown
}

// aisdk resources tracked for the aggregated cleanup (same pattern as
// AuthResources/DiscoveryResources): hook registration disposers (sdk +
// language, in registration order), the owned provider registry (each
// instance shut down exactly once), and the reuse cache keyed by a stable
// sanitized-settings key (per setup = per location, so the location component
// of the cache key is implicit).
export interface AisdkResources {
  ownedSdks: Set<KiroACPProvider>
  cache: Map<string, KiroACPProvider>
  disposeHooks: Array<() => Promise<void>>
}

export function createAisdkResources(): AisdkResources {
  return {
    ownedSdks: new Set(),
    cache: new Map(),
    disposeHooks: [],
  }
}

// accept the normalized bare name and (defensively) the raw `aisdk:`-prefixed
// catalog value, in case a future core stops normalizing before the event
function isKiroPackage(pkg: string): boolean {
  return pkg === KIRO_SDK_PACKAGE || pkg === `aisdk:${KIRO_SDK_PACKAGE}`
}

// Allowlist of KiroACPProviderSettings keys the factory consumes (installed
// d.ts). Excluded on purpose:
//  - effort / efforts: carried per-request via the language hook's
//    KiroACPModelOverrides — including them in the settings/key would defeat
//    provider sharing across efforts.
//  - onPermission: function-valued (unkeyable) and never set by the catalog.
//  - everything else (e.g. the host-injected `fetch`): not consumed by
//    createKiroAcp — dropping unknown keys is the allowlist's point.
// The `satisfies` clause is the compile pin: an SDK key rename breaks the
// build here.
const SETTINGS_ALLOWLIST = [
  "cwd",
  "model",
  "agent",
  "trustAllTools",
  "agentPrompt",
  "env",
  "clientInfo",
  "sessionId",
  "contextWindow",
  "contextWindows",
  "mcpTimeout",
  "stall",
] as const satisfies readonly (keyof KiroACPProviderSettings)[]

// pick the allowlisted keys present on the event options (skip undefined).
// The returned object is used for both the cache key and the `createKiroAcp`
// argument, so key and factory input can never diverge. Values are trusted:
// they originate from this plugin's own catalog transform (discovery.ts
// provider settings).
function sanitizeSettings(options: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const key of SETTINGS_ALLOWLIST) {
    const value = options[key]
    if (value !== undefined) settings[key] = value
  }
  return settings
}

// JSON-safe = only null/boolean/number/string and arrays/plain objects
// thereof. Function or exotic-object identities cannot be represented in a
// string key — never JSON-stringify those.
function isJsonSafe(value: unknown): boolean {
  if (value === null) return true
  const kind = typeof value
  if (kind === "string" || kind === "number" || kind === "boolean") return true
  if (Array.isArray(value)) return value.every(isJsonSafe)
  if (kind === "object") {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value as Record<string, unknown>).every(isJsonSafe)
  }
  return false
}

// deterministic stringify (sorted keys) — only ever called on JSON-safe data
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

// stable cache key for the sanitized+merged settings. Allowlisted values are
// JSON-safe by construction, so the key is defined for every production
// event; the isJsonSafe check is defense in depth — if a non-JSON-safe value
// ever slips through the allowlist, the undefined key makes the hook create
// and track a distinct owned instance instead of incorrectly reusing one
// (functions/exotic identities cannot be keyed).
export function stableSettingsKey(settings: Record<string, unknown>): string | undefined {
  return isJsonSafe(settings) ? stableStringify(settings) : undefined
}

// register the `sdk` + `language` hooks; returns one disposer that
// unregisters both hooks and shuts down every owned provider exactly once,
// attempting all even if some fail (combined AggregateError).
export async function registerAisdkHook(
  context: Plugin.Context,
  resources: AisdkResources,
): Promise<() => Promise<void>> {
  // providerID scoping per installed d.ts ModelHookOptions
  // (dist/promise/registration.d.ts): the hooks only fire for the kiro
  // provider. The isKiroPackage guard stays as defense in depth.
  const sdkRegistration = await context.aisdk.hook(
    "sdk",
    async (event: SdkHookEvent) => {
      if (!isKiroPackage(event.package)) return

      // sanitize before keying: the host spreads model settings into
      // event.options and injects `fetch`; only the allowlisted subset plus
      // the constant clientInfo may configure a provider, and the key derives
      // from that same merged object.
      const settings = { ...sanitizeSettings(event.options), clientInfo: CLIENT_INFO }
      const key = stableSettingsKey(settings)
      let sdk = key === undefined ? undefined : resources.cache.get(key)
      if (sdk === undefined) {
        const { createKiroAcp } = await import("kiro-acp-ai-provider")
        sdk = createKiroAcp(settings as KiroACPProviderSettings)
        resources.ownedSdks.add(sdk)
        if (key !== undefined) resources.cache.set(key, sdk)
      }

      // always assign, even when the host already populated it with an
      // unowned provider
      event.sdk = sdk
    },
    { providerID: KIRO_PROVIDER_ID },
  )
  resources.disposeHooks.push(sdkRegistration.dispose)

  // the host calls the language hook after the sdk hook with the resolved
  // `event.sdk`, so the owned provider is always the receiver. Per-request
  // effort travels here as a KiroACPModelOverrides override.
  let languageRegistration: Awaited<ReturnType<typeof context.aisdk.hook>>
  try {
    languageRegistration = await context.aisdk.hook(
      "language",
      async (event: LanguageHookEvent) => {
        // effort arrives via the host's variant-settings overlay on
        // event.options. String-guard only: the SDK's own precedence
        // (override, then per-model, then provider-level) handles the
        // settings-level efforts, so no further fallback is needed here.
        const effort = typeof event.options.effort === "string" ? event.options.effort : undefined
        const overrides =
          effort === undefined ? undefined : ({ effort } satisfies Pick<KiroACPModelOverrides, "effort">)
        // String(...) coercion local to this module on purpose: the branded
        // Model.ID reads as a plain string at runtime, and discovery.ts's
        // asString helper is private (non-exported).
        event.language = (event.sdk as KiroACPProvider).languageModel(String(event.model.modelID), overrides)
      },
      { providerID: KIRO_PROVIDER_ID },
    )
  } catch (error) {
    // no leaked sdk-hook registration when the second registration fails
    // mid-setup (registerAisdkHook has not returned its disposer yet)
    await sdkRegistration.dispose().catch(() => {})
    resources.disposeHooks.length = 0
    throw error
  }
  resources.disposeHooks.push(languageRegistration.dispose)

  return async () => {
    const errors: unknown[] = []

    // drain the disposer list before disposing (same discipline as ownedSdks)
    const disposeHooks = resources.disposeHooks.splice(0)
    for (const dispose of disposeHooks) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    // drain the registry before shutting down so a second cleanup pass (or a
    // failure mid-loop) can never shutdown() the same instance twice
    const owned = Array.from(resources.ownedSdks)
    resources.ownedSdks.clear()
    resources.cache.clear()
    for (const sdk of owned) {
      try {
        await sdk.shutdown()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "kiro aisdk cleanup failures")
  }
}
