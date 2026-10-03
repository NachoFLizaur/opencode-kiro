// Logout detection for a connected Kiro integration.
//
// A user who runs `kiro-cli logout` while opencode is open would otherwise
// only find out through a slow failing turn. The host fires the `context`
// session hook before every LLM step, so the plugin uses that beat to check
// kiro-cli's own answer with a fresh `verifyAuthAsync({ fresh: true })` probe
// and publishes the outcome on the kiro integration as
// `metadata.kiroLoggedOut = { stage }`. The TUI reads that flag and offers to
// reconnect; the host hides the models once the stale credential is gone.
//
// The hook is a detect-and-signal channel: the LLM step is never delayed
// (probes are started and tracked, never awaited on the step path) and the
// hook callback never rejects.
//
// Stage machine, per location:
// - none: a definitive negative (installed, not authenticated, not
//   inconclusive) moves to `suspected` with one reload and schedules ONE
//   follow-up fresh probe after LOGOUT_FOLLOW_UP_MS; the follow-up is the
//   confirming sample, so step-driven probes pause while it is pending.
// - suspected: a definitive negative (the follow-up, or a later step probe)
//   moves to `confirmed` with one reload. An inconclusive follow-up keeps
//   `suspected` and reschedules the follow-up once; a second inconclusive
//   result gives up (no automatic credential removal) and step probes resume.
// - confirmed: negatives are no-ops; nothing is reloaded.
// - any stage: an authenticated result clears the flag (one reload when it
//   was set), cancels a pending follow-up, and memoizes for LOGOUT_MEMO_MS so
//   a healthy session costs at most one probe per minute per location.
// - inconclusive results (whoami timed out or could not be spawned) never
//   advance the machine; a missing kiro-cli (`installed: false`) is a
//   different condition with its own guidance in the login flow and is ignored
//   here as well.
//
// Async discipline: every probe captures the state generation when it starts;
// after the await it acts only when the generation is unchanged and the state
// is not disposed. Every mutation bumps the generation, so a probe that
// crossed a login, a disposal or a newer transition is dropped silently.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time.
import type { Plugin } from "@opencode/plugin"
import type { AuthStatus } from "kiro-acp-ai-provider"

/** an authenticated result suppresses further step probes for this long */
export const LOGOUT_MEMO_MS = 60_000
/** delay between the first negative and the confirming follow-up probe */
export const LOGOUT_FOLLOW_UP_MS = 6_000
/** how many times an inconclusive follow-up is rescheduled before giving up */
export const LOGOUT_FOLLOW_UP_RETRIES = 1

const LOG_PREFIX = "[opencode-kiro]"

export type LogoutStage = "none" | "suspected" | "confirmed"

/** shape published under `metadata.kiroLoggedOut` on the kiro integration */
export interface LogoutFlag {
  stage: Exclude<LogoutStage, "none">
}

export const LOGOUT_METADATA_KEY = "kiroLoggedOut"

// per-location detector state, owned by this module and stored on the
// ServerState so the auth transform can read the stage and the login flow
// can report an authenticated observation
export interface LogoutState {
  stage: LogoutStage
  /** wall-clock instant until which step probes are skipped (authenticated memo) */
  memoUntil: number
  followUpTimer: NodeJS.Timeout | undefined
  /** true from scheduling the follow-up until its probe has been handled */
  followUpPending: boolean
  followUpRetriesLeft: number
  /** a step-driven probe is in flight */
  stepInflight: boolean
  /** bumped on every mutation; in-flight probes compare against it after their await */
  generation: number
  disposed: boolean
}

export function createLogoutState(): LogoutState {
  return {
    stage: "none",
    memoUntil: 0,
    followUpTimer: undefined,
    followUpPending: false,
    followUpRetriesLeft: 0,
    stepInflight: false,
    generation: 0,
    disposed: false,
  }
}

/** the metadata value for the current stage, or undefined when not flagged */
export function logoutFlag(state: LogoutState): LogoutFlag | undefined {
  return state.stage === "none" ? undefined : { stage: state.stage }
}

// write or strip `metadata.kiroLoggedOut` on an integration draft ref. The
// plugin-side IntegrationRef type carries only `id` and `name`, while the
// schema `Integration.Ref` the host materializes has an optional
// `metadata: Record<string, any>`; the cast below bridges that gap.
export function writeLogoutFlag(ref: { id: string; name: string }, state: LogoutState): void {
  const target = ref as { id: string; name: string; metadata?: Record<string, unknown> }
  const flag = logoutFlag(state)
  if (flag !== undefined) {
    target.metadata = { ...target.metadata, [LOGOUT_METADATA_KEY]: flag }
    return
  }
  if (target.metadata === undefined || !(LOGOUT_METADATA_KEY in target.metadata)) return
  const { [LOGOUT_METADATA_KEY]: _removed, ...rest } = target.metadata
  if (Object.keys(rest).length > 0) target.metadata = rest
  else delete target.metadata
}

export interface LogoutDetectorDeps {
  /** fresh auth probe; defaults to the SDK's `verifyAuthAsync({ fresh: true })` */
  probe?: () => Promise<AuthStatus>
  /** publishes the flag change; the integration transform runs again inside */
  reload: () => Promise<void>
}

export interface LogoutDetector {
  /** one LLM step for the kiro provider; returns synchronously */
  step(): void
  /** an authenticated observation from outside the detector (the login flow) */
  noteAuthenticated(): void
  /** cancel timers and drop every in-flight result */
  dispose(): void
}

async function defaultProbe(): Promise<AuthStatus> {
  const { verifyAuthAsync } = await import("kiro-acp-ai-provider")
  return verifyAuthAsync({ fresh: true })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// build the detector over `state`. Timers are plain Node timers so tests can
// drive them with fake timers; `deps.probe` is injectable for the same reason.
export function createLogoutDetector(state: LogoutState, deps: LogoutDetectorDeps): LogoutDetector {
  const probe = deps.probe ?? defaultProbe

  function bump(): void {
    state.generation += 1
  }

  function cancelFollowUp(): void {
    if (state.followUpTimer !== undefined) {
      clearTimeout(state.followUpTimer)
      state.followUpTimer = undefined
    }
    state.followUpPending = false
    state.followUpRetriesLeft = 0
  }

  // request one reload for a transition; a failing reload is reported, not
  // thrown, so the calling probe task settles normally
  async function reload(): Promise<void> {
    try {
      await deps.reload()
    } catch (error) {
      console.error(`${LOG_PREFIX} integration reload after a logout state change failed: ${describeError(error)}`)
    }
  }

  function scheduleFollowUp(): void {
    state.followUpPending = true
    const timer = setTimeout(() => {
      // a cancelled or replaced timer must not start a probe
      if (state.followUpTimer !== timer) return
      state.followUpTimer = undefined
      void run("follow-up")
    }, LOGOUT_FOLLOW_UP_MS)
    state.followUpTimer = timer
  }

  // apply one probe result. Returns the reload promise when a transition
  // happened so the caller can await it; undefined otherwise.
  function apply(status: AuthStatus, source: "step" | "follow-up"): Promise<void> | undefined {
    if (status.inconclusive === true) {
      if (source !== "follow-up") return undefined
      // the confirming sample gave no answer: try once more, then give up and
      // leave `suspected` in place for the TUI dialog or a later step probe
      if (state.followUpRetriesLeft > 0) {
        state.followUpRetriesLeft -= 1
        scheduleFollowUp()
      } else {
        state.followUpPending = false
      }
      return undefined
    }

    if (status.authenticated) {
      return applyAuthenticated()
    }

    // kiro-cli missing is not a logout; the login flow reports that case
    if (!status.installed) {
      if (source === "follow-up") state.followUpPending = false
      return undefined
    }

    // definitive negative: installed, kiro-cli answered, not authenticated
    switch (state.stage) {
      case "none":
        bump()
        state.stage = "suspected"
        state.followUpRetriesLeft = LOGOUT_FOLLOW_UP_RETRIES
        scheduleFollowUp()
        return reload()
      case "suspected":
        bump()
        state.stage = "confirmed"
        cancelFollowUp()
        return reload()
      case "confirmed":
        if (source === "follow-up") state.followUpPending = false
        return undefined
    }
  }

  function applyAuthenticated(): Promise<void> | undefined {
    bump()
    state.memoUntil = Date.now() + LOGOUT_MEMO_MS
    if (state.stage === "none") {
      cancelFollowUp()
      return undefined
    }
    state.stage = "none"
    cancelFollowUp()
    return reload()
  }

  // one probe task: start the fresh probe, then act on the result only when
  // the state is still the one the probe was started against
  async function run(source: "step" | "follow-up"): Promise<void> {
    const gen = state.generation
    if (source === "step") state.stepInflight = true
    try {
      const status = await probe()
      if (state.disposed || gen !== state.generation) return
      await apply(status, source)
    } catch (error) {
      if (state.disposed) return
      console.error(`${LOG_PREFIX} logout probe failed: ${describeError(error)}`)
      if (source === "follow-up" && gen === state.generation) state.followUpPending = false
    } finally {
      if (source === "step") state.stepInflight = false
    }
  }

  return {
    step(): void {
      if (state.disposed) return
      if (state.stepInflight || state.followUpPending) return
      // the memo is written by authenticated results only, so a flagged or
      // given-up location probes on every step
      if (Date.now() < state.memoUntil) return
      void run("step")
    },
    noteAuthenticated(): void {
      if (state.disposed) return
      void applyAuthenticated()
    },
    dispose(): void {
      state.disposed = true
      bump()
      cancelFollowUp()
    },
  }
}

// register the `context` session hook driving the detector, scoped to
// `providerID` (the caller passes the kiro provider id; this module imports no
// sibling module so auth.ts can import it without a cycle). Returns one
// disposer that stops the detector and unregisters the hook.
export async function registerLogoutDetector(
  context: Plugin.Context,
  detector: LogoutDetector,
  providerID: string,
): Promise<() => Promise<void>> {
  // providerID scoping per installed d.ts ModelHookOptions
  // (dist/promise/registration.d.ts): the hook only fires for kiro steps
  const registration = await context.session.hook(
    "context",
    () => {
      // detect-and-signal only: nothing on the step path is awaited or thrown
      detector.step()
    },
    { providerID },
  )

  return async () => {
    detector.dispose()
    await registration.dispose()
  }
}
