// Catalog transform + async runtime model discovery lifecycle.
//
// The catalog transform is a synchronous mutation phase: it reads only the
// captured last-known-good discovery snapshot and never performs I/O. The
// asynchronous `listModels({ cwd })` discovery runs outside transforms, guarded
// by a generation token (stale completions after logout or a newer discovery
// are discarded) and coalesced (concurrent discover() calls share one in-flight
// call). `catalog.reload()` is only ever called from discovery code paths, never
// from inside the transform. Discovery fails open: an empty snapshot, duplicate
// runtime modelIds, or an exception leave the previous catalog data untouched.
// A probe that fails or exceeds its deadline is reported on stderr and retried
// with bounded backoff while the connection stays active.
// The SDK import stays lazy so dist/server.js loads under plain Node.
import type { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import type { KiroACPProviderSettings, ModelWithEfforts } from "kiro-acp-ai-provider"
import { KIRO_INTEGRATION_ID, KIRO_INTEGRATION_NAME } from "./auth.js"

// the provider is resolved via `Provider.Info.package` (normalized to the
// package name for the SDK event).
export const KIRO_PROVIDER_ID = "kiro"
export const KIRO_PROVIDER_PACKAGE = "aisdk:kiro-acp-ai-provider"

// derive editor/model/event types from the installed d.ts (the editor and
// the event union are not exported from the package root)
type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]
type MutableModel = Parameters<Parameters<ProviderEditor["models"]["update"]>[2]>[0]
type ServerEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never

// DeepMutable maps over branded-string intersections and yields a non-string
// mapped type; at runtime these values are plain strings, so reads coerce back
function asString(value: unknown): string {
  return value as string
}

// resolved plugin options (defaults applied by src/server.ts `resolveOptions`).
// Exactly four keys — `trustAllTools` stays hardcoded and `cwd` is not an
// option by design: the per-location `integration.list().location.directory`
// derivation is strictly better than a user-supplied path.
//
// `stall` mirrors the SDK's `KiroACPProviderSettings.stall` (stall watchdog:
// `afterMs` silence threshold, `live` channel for the notice). It is optional
// end to end: when the user sets nothing it stays undefined and is omitted
// from the emitted provider settings, so the SDK defaults apply.
// @since 0.5.0-beta.5 (`stall`)
export interface KiroPluginOptions {
  agent: string
  mcpTimeout: number
  discover: boolean
  stall?: NonNullable<KiroACPProviderSettings["stall"]>
}

// per-location discovery state, created during `src/server.ts` setup. `cwd`
// comes from a public location-bearing response during setup — never from
// `process.cwd()` captured at module load. `options` are the resolved plugin
// options the transform emits into `provider.settings`.
//
// `probeTimer` bounds the in-flight `listModels` call; `retryTimer` holds the
// next scheduled attempt after a failed or timed-out probe (the attempt count
// of the current chain travels as a parameter, not in state). Both timers are
// cleared by cleanup: a generation bump alone would only make a fired timer a
// no-op, it would not remove the pending handle.
export interface DiscoveryState {
  cwd: string
  options: KiroPluginOptions
  snapshot: readonly ModelWithEfforts[] | undefined
  generation: number
  inflight: Promise<void> | undefined
  probeTimer: ReturnType<typeof setTimeout> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

// upper bound for one `listModels` probe. The SDK call has no cancellation, so
// a probe that outlives the deadline is only abandoned: its eventual result is
// judged by the generation token like any other completion.
const DISCOVERY_TIMEOUT_MS = 60_000

// delays before the next attempt after the first, second and third failure of
// one discovery chain; the chain stops after the last step until the next
// credential event or explicit discover() starts a new one.
const RETRY_BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000]

// stderr is the only diagnostics channel available to a server plugin (the
// host prints it under `opencode serve` / OPENCODE_PRINT_LOGS=1). The prefix
// is stable so operators can grep for it.
const LOG_PREFIX = "[opencode-kiro]"

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cancelRetry(state: DiscoveryState): void {
  if (state.retryTimer !== undefined) {
    clearTimeout(state.retryTimer)
    state.retryTimer = undefined
  }
}

function clearDiscoveryTimers(state: DiscoveryState): void {
  if (state.probeTimer !== undefined) {
    clearTimeout(state.probeTimer)
    state.probeTimer = undefined
  }
  cancelRetry(state)
}

// discovery resources tracked for the aggregated cleanup (same pattern as
// AuthResources): transform disposer, event iterator + its consumer task, and
// the state carrying the inflight promise, the probe/retry timers and the
// generation counter (invalidated on cleanup by a final bump).
export interface DiscoveryResources {
  state: DiscoveryState | undefined
  disposeTransform: (() => Promise<void>) | undefined
  eventIterator: AsyncIterator<ServerEvent, unknown, unknown> | undefined
  eventTask: Promise<void> | undefined
}

export function createDiscoveryResources(): DiscoveryResources {
  return {
    state: undefined,
    disposeTransform: undefined,
    eventIterator: undefined,
    eventTask: undefined,
  }
}

// effort-variant merge: empty runtime efforts → model untouched (no invented
// variants); a defined baseline effort lands in `model.settings.effort`; each
// runtime effort upserts a `variants[]` entry whose `settings.effort` carries
// the effort string unchanged. Existing catalog variants not named by the
// runtime are preserved.
//
// The variant settings key must be the SDK's own `KiroACPProviderSettings.effort`
// key: the host overlays the selected variant's settings onto `model.settings`,
// which becomes the aisdk hooks' `event.options`, and the `language` hook in
// src/server/aisdk.ts reads `event.options.effort` to forward it per request.
// The `satisfies` pin makes an SDK key rename a compile error here.
function effortSettings(effort: string): { effort: string } {
  return { effort } satisfies Pick<KiroACPProviderSettings, "effort">
}

function applyEfforts(model: MutableModel, runtimeModel: ModelWithEfforts): void {
  if (runtimeModel.runtimeEfforts.length === 0) return

  if (runtimeModel.baselineEffort !== undefined) {
    model.settings = { ...model.settings, ...effortSettings(runtimeModel.baselineEffort) }
  }

  for (const effort of runtimeModel.runtimeEfforts) {
    const existing = model.variants.find((variant) => asString(variant.id) === effort)
    if (existing !== undefined) {
      existing.settings = { ...existing.settings, ...effortSettings(effort) }
    } else {
      model.variants.push({
        id: effort as Model.VariantID,
        settings: effortSettings(effort),
      })
    }
  }
}

// mirrors `Model.Info.default` from @opencode/plugin; inlined so dist/server.js
// keeps loading under plain Node without a runtime import of the plugin SDK
function defaultModel(modelId: string): MutableModel {
  return {
    id: modelId,
    modelID: modelId,
    providerID: KIRO_PROVIDER_ID,
    name: modelId,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  } as unknown as MutableModel
}

// synchronous provider transform body. Reads only the captured snapshot:
// - empty/undefined snapshot → provider left untouched (fail open)
// - rich Kiro entry (models.dev or another plugin) → exact case-sensitive
//   intersection of `Model.Info.modelID` against runtime `modelId`, metadata
//   preserved
// - no rich entry → minimal self-registration of only runtime-returned models
// Provider settings carry the deterministic SDK factory inputs that become
// `event.options` for the aisdk hooks; `contextWindows` is keyed by the API
// model ID (`Model.Info.modelID`), not the catalog key. `agent`, `mcpTimeout`
// and (when configured) `stall` come from the resolved plugin options; all
// three keys are on the sdk hook's SETTINGS_ALLOWLIST (src/server/aisdk.ts),
// so custom values reach `createKiroAcp` through provider → host overlay →
// `event.options` unchanged. `stall` is omitted when unset so the SDK
// defaults apply.
export function applyCatalogSnapshot(editor: ProviderEditor, state: DiscoveryState): void {
  const snapshot = state.snapshot
  if (snapshot === undefined || snapshot.length === 0) return

  const runtime = new Map(snapshot.map((model) => [model.modelId, model]))

  const record = editor.get(KIRO_PROVIDER_ID)
  const rich = record !== undefined && record.models.size > 0

  const contextWindows: Record<string, number> = {}

  if (rich) {
    // snapshot the entries first: removal mutates the underlying map
    for (const [catalogKey, catalogModel] of Array.from(record.models.entries())) {
      const runtimeModel = runtime.get(asString(catalogModel.modelID))
      if (runtimeModel === undefined) {
        editor.models.remove(KIRO_PROVIDER_ID, catalogKey)
        continue
      }
      editor.models.update(KIRO_PROVIDER_ID, catalogKey, (model) => {
        applyEfforts(model, runtimeModel)
        if (model.limit.context > 0) contextWindows[asString(model.modelID)] = model.limit.context
      })
    }
  } else {
    // fallback: publish only models actually returned by the runtime
    const models = snapshot.map((runtimeModel) => {
      const model = defaultModel(runtimeModel.modelId)
      model.name = runtimeModel.name || runtimeModel.modelId
      applyEfforts(model, runtimeModel)
      if (model.limit.context > 0) contextWindows[asString(model.modelID)] = model.limit.context
      return model as unknown as Model.Info
    })
    if (record === undefined) {
      editor.add({
        info: {
          id: KIRO_PROVIDER_ID,
          name: KIRO_INTEGRATION_NAME,
          activation: "auto",
          package: KIRO_PROVIDER_PACKAGE,
        } as unknown as Provider.Info,
        models,
      })
    } else {
      editor.models.set(KIRO_PROVIDER_ID, models)
    }
  }

  editor.update(KIRO_PROVIDER_ID, (provider) => {
    provider.name = KIRO_INTEGRATION_NAME
    provider.integrationID = KIRO_INTEGRATION_ID as Integration.ID
    provider.package = KIRO_PROVIDER_PACKAGE
    provider.settings = {
      ...provider.settings,
      cwd: state.cwd,
      agent: state.options.agent,
      trustAllTools: true, // intentionally not exposed as a plugin option
      mcpTimeout: state.options.mcpTimeout,
      ...(state.options.stall !== undefined ? { stall: state.options.stall } : {}),
      contextWindows,
    }
  })
}

// discovery operation factory. The returned `discover(reason)`:
// 1. re-checks `connection.active("kiro")` — not active → cancel any pending
//    retry, clear snapshot, bump generation (invalidates in-flight
//    completions), reload
// 2. coalesces onto an existing in-flight discovery
// 3. runs `listModels({ cwd })` under a captured generation token, bounded by
//    DISCOVERY_TIMEOUT_MS
// 4. validates unique case-sensitive modelIds; duplicates/exceptions → keep
//    previous snapshot, no reload of partial data (fail open)
// 5. discards stale completions (`gen !== state.generation`) silently
// 6. atomically replaces the snapshot, then reloads (outside the transform)
//
// Retry invariant. A failed or timed-out probe schedules the next attempt
// after RETRY_BACKOFF_MS[attempt]. The oracle for every attempt is the pair
// `connection.active("kiro")` + `gen === state.generation`, read immediately
// before the attempt runs (and re-read after the `connection.active` await).
// Either check failing ends the chain silently: the plugin keeps working
// without a runtime catalog and nothing is thrown out of setup or the event
// consumer. The chain is also ended by backoff exhaustion (after the last
// step) and by cleanup (timer cleared). A new discover() cancels the pending
// retry before it starts its own probe, so at most one attempt chain exists
// per location at any time. Every failure and timeout is reported on stderr
// with the `[opencode-kiro]` prefix; a stale failure (superseded generation)
// is not reported because its outcome no longer matters.
export function createDiscover(
  context: Plugin.Context,
  state: DiscoveryState,
): (reason: string) => Promise<void> {
  // apply one probe result: stale or duplicate-id results leave the previous
  // snapshot untouched. A result for the current generation also makes any
  // pending retry redundant.
  async function publish(gen: number, discovered: readonly ModelWithEfforts[]): Promise<void> {
    // stale: logout, a newer discovery or cleanup bumped the generation mid-flight
    if (gen !== state.generation) return
    const uniqueIds = new Set(discovered.map((model) => model.modelId))
    if (uniqueIds.size !== discovered.length) {
      console.error(
        `${LOG_PREFIX} model discovery for ${state.cwd} returned duplicate model ids; catalog left unchanged`,
      )
      return
    }
    cancelRetry(state)
    state.snapshot = discovered
    await context.provider.reload()
  }

  // rejects once the probe deadline passes. The SDK promise cannot be
  // cancelled, so after the deadline it is only abandoned: a completion that
  // still arrives is handed to publish(), where the generation token decides.
  // A retry bumps the generation and turns the abandoned result stale; until
  // a retry starts (or after the chain has given up) a late result for the
  // still-current generation is applied, which is the desired outcome.
  function probeDeadline(gen: number, probe: Promise<readonly ModelWithEfforts[]>): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.probeTimer === timer) state.probeTimer = undefined
        void probe.then((discovered) => publish(gen, discovered)).catch(() => {})
        reject(new Error(`no response after ${DISCOVERY_TIMEOUT_MS / 1000}s`))
      }, DISCOVERY_TIMEOUT_MS)
      state.probeTimer = timer
      const settle = (): void => {
        clearTimeout(timer)
        if (state.probeTimer === timer) state.probeTimer = undefined
      }
      probe.then(settle, settle)
    })
  }

  async function runDiscovery(gen: number, attempt: number): Promise<void> {
    try {
      const { listModels } = await import("kiro-acp-ai-provider")
      const probe = listModels({ cwd: state.cwd })
      const discovered = await Promise.race([probe, probeDeadline(gen, probe)])
      await publish(gen, discovered)
    } catch (error) {
      // superseded mid-flight: the outcome no longer matters, stay silent
      if (gen !== state.generation) return
      const delay: number | undefined = RETRY_BACKOFF_MS[attempt]
      const next =
        delay === undefined ? "giving up until the next credential change" : `retrying in ${delay / 1000}s`
      console.error(
        `${LOG_PREFIX} model discovery failed for ${state.cwd} (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}): ${describeError(error)}; ${next}`,
      )
      if (delay !== undefined) scheduleRetry(gen, attempt + 1, delay)
    }
  }

  // start one probe under a fresh generation and track it as the in-flight
  // discovery other callers coalesce onto
  function start(attempt: number): Promise<void> {
    const gen = ++state.generation
    const run = runDiscovery(gen, attempt).finally(() => {
      if (state.inflight === run) state.inflight = undefined
    })
    state.inflight = run
    return run
  }

  function scheduleRetry(gen: number, attempt: number, delay: number): void {
    cancelRetry(state)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      void retry(gen, attempt).catch(() => {})
    }, delay)
  }

  // one retry tick: both oracle reads happen here, the second one after the
  // `connection.active` await so a logout or a newer discovery that landed
  // during the await still ends the chain
  async function retry(gen: number, attempt: number): Promise<void> {
    if (gen !== state.generation) return
    const active = await context.integration.connection.active(KIRO_INTEGRATION_ID)
    if (!active || gen !== state.generation) return
    await start(attempt)
  }

  return async function discover(_reason: string): Promise<void> {
    const active = await context.integration.connection.active(KIRO_INTEGRATION_ID)
    if (!active) {
      cancelRetry(state)
      state.generation += 1
      state.snapshot = undefined
      await context.provider.reload()
      return
    }

    if (state.inflight !== undefined) return state.inflight

    // a fresh chain supersedes any pending retry of the previous one
    cancelRetry(state)
    return start(0)
  }
}

// Credential-event filter covering both host generations. Older hosts emit
// `integration.connection.updated`; newer hosts replaced it with
// `credential.updated` + `credential.switched` (multi-account credentials).
// The plugin accepts all three names: a host never fires both generations, so
// listening for both is safe either way.
//
// The legacy name is absent from the installed d.ts event-type union, so a
// typed literal comparison would not compile (TS2367). `event.type` is read
// through a widened `string` for the legacy check; this is deliberate
// backward compatibility, not dead code.
function isKiroCredentialEvent(event: ServerEvent): boolean {
  const type: string = event.type

  // legacy hosts (pre multi-account): kiro-scope on the payload
  if (type === "integration.connection.updated") {
    const data = (event as { data?: { integrationID?: unknown } }).data
    return data?.integrationID === KIRO_INTEGRATION_ID
  }

  // new hosts: `{integrationID, credentialID(nullable)}` — kiro-scope on
  // integrationID; credentialID (null on sign-out of the active credential)
  // is irrelevant here — discover() re-checks connection.active anyway
  if (event.type === "credential.switched") {
    return asString(event.data.integrationID) === KIRO_INTEGRATION_ID
  }

  // new hosts: empty payload (`Struct<{}>`) — cannot scope by integration;
  // the `connection.active("kiro")` re-check inside discover() is the scoping
  // (over-firing on multi-integration hosts is absorbed by coalescing)
  return type === "credential.updated"
}

// setup-owned event consumer: filters the credential events for Kiro and runs
// a discovery. Login/logout is never inferred from the event — discover()
// re-checks `connection.active`. Never rejects (cleanup awaits this task).
//
// The discovery is started without awaiting it so the loop returns to the
// iterator immediately. A login emits several credential events in quick
// succession; while the first probe is in flight, the events that follow
// coalesce onto it inside discover(), so one login yields one probe per
// location. Awaiting here instead would serialize the events and run one probe
// per event.
async function consumeEvents(
  iterator: AsyncIterator<ServerEvent, unknown, unknown>,
  discover: (reason: string) => Promise<void>,
): Promise<void> {
  try {
    while (true) {
      const result = await iterator.next()
      if (result.done) return
      const event = result.value
      if (isKiroCredentialEvent(event)) {
        // discovery failures must not kill the event loop
        void discover(event.type).catch(() => {})
      }
    }
  } catch {
    // subscription ended (cleanup called return()) or transport error
  }
}

// register the catalog transform + event consumer and kick off one coalesced
// initial discovery when Kiro is already connected and `options.discover` is
// not false. Returns one disposer that invalidates pending generations, clears
// the probe/retry timers, stops/awaits the event consumer, and unregisters the
// transform. An in-flight `listModels` has no documented cancellation — it is
// not awaited; the final generation bump guarantees its completion is
// discarded.
export async function registerDiscovery(
  context: Plugin.Context,
  resources: DiscoveryResources,
  options: KiroPluginOptions,
): Promise<() => Promise<void>> {
  // per-location cwd from a public location-bearing response — never
  // process.cwd() at module load, and never a plugin option
  const { location } = await context.integration.list()
  const state: DiscoveryState = {
    cwd: location.directory,
    options,
    snapshot: undefined,
    generation: 0,
    inflight: undefined,
    probeTimer: undefined,
    retryTimer: undefined,
  }
  resources.state = state

  const discover = createDiscover(context, state)

  const registration = await context.provider.transform((editor) =>
    applyCatalogSnapshot(editor, state),
  )
  resources.disposeTransform = registration.dispose

  const iterator = context.event.subscribe()[Symbol.asyncIterator]()
  resources.eventIterator = iterator
  resources.eventTask = consumeEvents(iterator, discover)

  // setup kick-off: one coalesced discovery, fire-and-forget so setup does
  // not block on model listing; discover() never rejects past this guard.
  // `discover: false` gates only this setup-time kick-off — the event-driven
  // path (consumeEvents → discover) stays live so a user who logs in later
  // still gets models.
  if (options.discover && (await context.integration.connection.active(KIRO_INTEGRATION_ID))) {
    void discover("setup").catch(() => {})
  }

  return async () => {
    // final bump: any in-flight discovery completion becomes stale. The bump
    // alone would leave a scheduled retry or probe deadline pending (fired as
    // a no-op later), so the timers are cleared explicitly.
    state.generation += 1
    clearDiscoveryTimers(state)

    const errors: unknown[] = []

    const eventIterator = resources.eventIterator
    resources.eventIterator = undefined
    if (eventIterator?.return !== undefined) {
      try {
        await eventIterator.return()
      } catch (error) {
        errors.push(error)
      }
    }

    const eventTask = resources.eventTask
    resources.eventTask = undefined
    if (eventTask !== undefined) await eventTask // never rejects

    const disposeTransform = resources.disposeTransform
    resources.disposeTransform = undefined
    if (disposeTransform !== undefined) {
      try {
        await disposeTransform()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "kiro discovery cleanup failures")
  }
}
