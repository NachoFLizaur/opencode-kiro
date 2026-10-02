// Per-location server state + aggregated idempotent cleanup builder.
//
// One setup call = one location = one ServerState instance. Nothing in the
// server modules is module-global except pure helpers and constants — the host
// may invoke setup once per location, and each invocation owns its resources.
//
// The state consolidates everything the auth, discovery, and aisdk modules
// track, via the typed resource records those modules own (kept nested rather
// than flattened so auth.ts/discovery.ts keep sole ownership of their fields):
// - cwd / snapshot / generation / inflight  -> discovery.state
// - eventIterator / eventTask               -> discovery
// - loginChild / pollTimer / cancelPoll     -> auth
// - ownedSdks                               -> aisdk
// - disposers                               -> registration disposers, in order
import type { Plugin } from "@opencode/plugin"
import { type AisdkResources, createAisdkResources } from "./aisdk.js"
import { type AuthResources, createAuthResources } from "./auth.js"
import { type DiscoveryResources, createDiscoveryResources } from "./discovery.js"

export interface ServerState {
  auth: AuthResources
  discovery: DiscoveryResources
  aisdk: AisdkResources
  /** registration disposers pushed in setup order; cleanup runs them reversed */
  disposers: Array<() => void | Promise<void>>
  disposed: boolean
  /** the single cleanup promise; later cleanup calls return this same promise */
  cleanup: Promise<void> | undefined
}

export function createServerState(): ServerState {
  return {
    auth: createAuthResources(),
    discovery: createDiscoveryResources(),
    aisdk: createAisdkResources(),
    disposers: [],
    disposed: false,
    cleanup: undefined,
  }
}

// attempt every disposer even if one fails. Each registered disposer already
// covers its own resource contract internally with the same attempt-all
// discipline: auth (kill login child, clear poll timer, settle pending poll,
// dispose the integration registration), discovery (final generation bump so
// pending discoveries are discarded, stop/await the event iterator via
// return(), await the event task, dispose the catalog transform), aisdk
// (dispose the hook registration, shutdown() each owned provider exactly
// once). Sub-AggregateErrors are flattened so the combined report lists every
// underlying failure once.
async function disposeAll(disposers: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = []
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose()
    } catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors)
      else errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "kiro server cleanup failures")
}

// aggregated idempotent cleanup: the first call marks the state disposed and
// builds/stores one cleanup promise that attempts every resource; later calls
// return that same promise, so each underlying resource is disposed at most
// once. Also used for the setup failure path (partial cleanup over whatever
// disposers were registered before the failure).
export function buildCleanup(state: ServerState): Plugin.Cleanup {
  return () => {
    if (state.cleanup !== undefined) return state.cleanup
    state.disposed = true
    state.cleanup = disposeAll(state.disposers)
    return state.cleanup
  }
}
