// Retry safety net for not-logged-in failures.
//
// When kiro-cli is logged out, a turn fails with the SDK's not-logged-in
// error. Retrying cannot help until the user logs in again, so the host's
// retry loop would only add delay and repeat the same failure. The host fires
// the `retry` session hook for every failure while attempts remain, with a
// decision it proposes and the plugin may override; this module turns that
// decision into "do not retry" for exactly the not-logged-in errors and leaves
// every other error, and the host's proposal for it, untouched.
//
// Matching: the SDK's `isKiroNotLoggedInError` is consulted first. It checks
// the machine-readable marker (`data.reason`) before the message phrases, and
// it handles the `{ message }` shape the hook receives (the host's error type
// carries `type`, `message` and `status` only, so the marker does not survive
// the boundary and the message branch is the one that fires). When the SDK
// cannot be imported, a local check over the same two phrases is used, so the
// safety net still works. The hook callback never rejects: any failure
// resolves to "leave the decision alone".
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time.
import type { Plugin } from "@opencode/plugin"

const LOG_PREFIX = "[opencode-kiro]"

// the SDK's not-logged-in wording, mirrored here for the fallback path only;
// the SDK matcher remains the source of truth when it loads
const NOT_LOGGED_IN_PHRASES: readonly string[] = [
  "Not logged in. Run 'kiro-cli login'",
  "does not appear logged in",
]

/** structural mirror of the host's SessionError.Error (type, message, status) */
export interface RetryError {
  readonly type: string
  readonly message: string
  readonly status?: number
}

/** structural mirror of the host's SessionRetryDecision */
export type RetryDecision = { retry: false } | { retry: true; delay: number }

/** the members of the host's SessionRetry input this module reads and writes */
export interface RetryInput {
  readonly error: RetryError
  decision: RetryDecision
}

export type NotLoggedInMatcher = (value: unknown) => boolean

export interface RetryGuardDeps {
  /** resolves the not-logged-in matcher; defaults to importing the SDK's */
  loadMatcher?: () => Promise<NotLoggedInMatcher>
}

export interface RetryGuard {
  /** apply the guard to one retry hook input; never rejects */
  decide(input: RetryInput): Promise<void>
}

/** local fallback: the same two phrases the SDK matcher knows, on a string or a `{ message }` value */
export function isNotLoggedInMessage(value: unknown): boolean {
  const message =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? (value as { message?: unknown }).message
        : undefined
  return typeof message === "string" && NOT_LOGGED_IN_PHRASES.some((phrase) => message.includes(phrase))
}

async function loadSdkMatcher(): Promise<NotLoggedInMatcher> {
  const sdk = await import("kiro-acp-ai-provider")
  const matcher = (sdk as { isKiroNotLoggedInError?: unknown }).isKiroNotLoggedInError
  if (typeof matcher !== "function") {
    throw new Error("the installed SDK does not export isKiroNotLoggedInError")
  }
  return matcher as NotLoggedInMatcher
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// build the guard. The SDK matcher is loaded on first use and kept once it
// resolves; a failed load is reported once per guard and falls back to the
// local phrase check for that call, leaving a later call free to try again.
export function createRetryGuard(deps: RetryGuardDeps = {}): RetryGuard {
  const loadMatcher = deps.loadMatcher ?? loadSdkMatcher
  let matcher: NotLoggedInMatcher | undefined
  let loadFailureReported = false

  async function resolveMatcher(): Promise<NotLoggedInMatcher> {
    if (matcher !== undefined) return matcher
    try {
      matcher = await loadMatcher()
      return matcher
    } catch (error) {
      if (!loadFailureReported) {
        loadFailureReported = true
        console.error(
          `${LOG_PREFIX} not-logged-in matcher unavailable, using the built-in phrase check: ${describeError(error)}`,
        )
      }
      return isNotLoggedInMessage
    }
  }

  return {
    async decide(input: RetryInput): Promise<void> {
      try {
        const match = await resolveMatcher()
        if (match(input.error)) input.decision = { retry: false }
      } catch (error) {
        // the matcher itself failed on this value: leave the host's decision
        console.error(`${LOG_PREFIX} retry guard could not classify the error: ${describeError(error)}`)
      }
    },
  }
}

// register the `retry` session hook driving the guard, scoped to `providerID`
// (the kiro provider id, passed by the caller so this module imports no
// sibling module). Returns one disposer that unregisters the hook.
export async function registerRetryGuard(
  context: Plugin.Context,
  guard: RetryGuard,
  providerID: string,
): Promise<() => Promise<void>> {
  // providerID scoping per installed d.ts ModelHookOptions
  // (dist/promise/registration.d.ts): the hook only fires for kiro failures
  const registration = await context.session.hook(
    "retry",
    async (input) => {
      await guard.decide(input)
    },
    { providerID },
  )

  return async () => {
    await registration.dispose()
  }
}
