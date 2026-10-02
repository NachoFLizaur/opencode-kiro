// Integration `kiro` + Credential OAuth auth flow.
//
// Auth authority is `verifyAuthAsync()` from kiro-acp-ai-provider (delegates
// to kiro-cli). Only the async probe is used: the sync `verifyAuth()` runs two
// blocking execFileSync calls (kiro-cli `--version` + `whoami`, 10s timeouts
// each) and, polled every 2s, would stall the host event loop. The SDK
// contract: identical AuthStatus + shared 5s memo, concurrent callers
// coalesce, and it never rejects. OpenCode never stores real AWS tokens: the
// Credential.OAuth returned here is a minimal presence record
// (`access: "kiro-cli"`, `expires: 0`) and the Integration refresh callback is
// deliberately not implemented — kiro-cli owns credential storage and refresh.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time.
import type { Credential, Integration, Plugin } from "@opencode/plugin"
import type { AuthStatus } from "kiro-acp-ai-provider"
import type { ChildProcess } from "node:child_process"

export const KIRO_INTEGRATION_ID = "kiro"
export const KIRO_INTEGRATION_NAME = "Kiro"
export const KIRO_OAUTH_METHOD_ID = "kiro-cli-login"
export const KIRO_OAUTH_METHOD_LABEL = "Kiro CLI Login"

// docs URL shown with the login attempt (the login browser window is opened by
// kiro-cli itself; the plugin never invents a callback URL)
export const KIRO_DOCS_URL = "https://kiro.dev/docs/cli/"

// poll cadence/limits
const POLL_INTERVAL_MS = 2_000
const MAX_WAIT_MS = 120_000

const NOT_INSTALLED_MESSAGE = "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/"
const TIMEOUT_MESSAGE =
  "Kiro authentication timed out. Run `kiro-cli login` manually, then re-run `opencode auth login`."
const CANCELLED_MESSAGE = "Kiro authentication was cancelled."
const SUPERSEDED_MESSAGE = "Kiro CLI login superseded by a new login attempt."
const LOGIN_INSTRUCTIONS =
  "Complete Kiro authentication in the browser window that just opened (if no browser opened, run `kiro-cli login` in another terminal). Waiting for login..."
const ALREADY_AUTHENTICATED_INSTRUCTIONS = "Already authenticated with Kiro CLI."

// login-flow resources tracked for the aggregated server cleanup: the spawned
// kiro-cli child, the poll timer, the pending-poll canceller (settles the
// attempt promise on disposal so nothing awaits forever), and the integration
// registration disposer. One instance is shared by every authorize() attempt,
// so an attempt must release its predecessor before claiming the fields (see
// the supersede step in authorize()).
export interface AuthResources {
  child: ChildProcess | undefined
  pollTimer: NodeJS.Timeout | undefined
  // rejects the pending attempt; `reason` defaults to the cancellation error
  cancelPoll: ((reason?: Error) => void) | undefined
  disposeRegistration: (() => Promise<void>) | undefined
}

export function createAuthResources(): AuthResources {
  return {
    child: undefined,
    pollTimer: undefined,
    cancelPoll: undefined,
    disposeRegistration: undefined,
  }
}

// kill the child, clear the poll timer, and settle any pending poll promise
// (rejecting with `reason`, or the cancellation error when omitted).
// idempotent; used on success, timeout, supersession, and plugin disposal.
export function releaseLoginResources(resources: AuthResources, reason?: Error): void {
  if (resources.pollTimer !== undefined) {
    clearTimeout(resources.pollTimer)
    resources.pollTimer = undefined
  }
  if (resources.child !== undefined) {
    resources.child.kill()
    resources.child = undefined
  }
  if (resources.cancelPoll !== undefined) {
    const cancel = resources.cancelPoll
    resources.cancelPoll = undefined
    cancel(reason)
  }
}

// minimal Credential.OAuth: no synthetic expiry (expires: 0), no copied AWS
// token data, stable non-secret `access` presence value.
function kiroCredential(): Credential.OAuth {
  return {
    type: "oauth",
    methodID: KIRO_OAUTH_METHOD_ID as Integration.MethodID,
    refresh: "",
    access: "kiro-cli",
    expires: 0,
  }
}

// structural mirror of the installed d.ts `IntegrationOAuthAuthorization`
// (dist/promise/integration.d.ts) — the type is not exported from the package
// root, so a local alias that stays assignable to it is kept here.
type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & {
  readonly mode: "auto"
  readonly callback: Promise<Credential.OAuth>
}

// poll verifyAuthAsync() every 2s for up to 120s. Resolves with the credential
// on success; rejects on timeout with manual-login guidance; rejects with a
// cancellation error when the plugin is disposed mid-poll.
//
// The tick awaits the probe, so disposal (or supersession by a newer attempt)
// can fire `cancelPoll` (rejecting the attempt) while a probe is in flight.
// After the await, the tick checks that `resources.cancelPoll` is still its
// own canceller — any other value means the attempt already settled (cancel,
// success, or timeout disarmed it to undefined) or a newer attempt now owns
// the shared fields. Either way the tick bails silently: no timer re-arm
// (which would leak a timer after cleanup, or run two poll loops against one
// resource set) and no second settle / no touching the successor's child.
function pollForLogin(
  verifyAuth: () => Promise<AuthStatus>,
  resources: AuthResources,
): Promise<Credential.OAuth> {
  return new Promise<Credential.OAuth>((resolve, reject) => {
    // elapsed time is measured from promise construction, so probe duration
    // counts against the 120s budget
    const start = Date.now()

    const cancel = (reason?: Error) => {
      reject(reason ?? new Error(CANCELLED_MESSAGE))
    }
    resources.cancelPoll = cancel

    const tick = async (): Promise<void> => {
      resources.pollTimer = undefined
      // no try/catch: the SDK guarantees verifyAuthAsync() never rejects
      const status = await verifyAuth()
      // cancelled, settled, or superseded mid-probe: no re-arm, no settle
      if (resources.cancelPoll !== cancel) return
      if (status.authenticated) {
        // disarm the canceller before releasing so release cannot settle the
        // attempt as cancelled ahead of the real resolution
        resources.cancelPoll = undefined
        releaseLoginResources(resources)
        resolve(kiroCredential())
        return
      }
      if (Date.now() - start >= MAX_WAIT_MS) {
        // same disarm-first ordering: timeout must reject with guidance, not
        // surface as a cancellation
        resources.cancelPoll = undefined
        releaseLoginResources(resources)
        reject(new Error(TIMEOUT_MESSAGE))
        return
      }
      // `void tick()` keeps the timer callback synchronous-typed
      resources.pollTimer = setTimeout(() => {
        void tick()
      }, POLL_INTERVAL_MS)
    }

    resources.pollTimer = setTimeout(() => {
      void tick()
    }, POLL_INTERVAL_MS)
  })
}

// OAuth authorize covering the six auth states:
// 1. CLI absent      -> reject with installation guidance, no credential, no spawn
// 2. already authed  -> automatic attempt resolving immediately, no spawn
// 3. unauthenticated -> spawn `kiro-cli login`, mode "auto", poll 2s/<=120s
// 4. success         -> kill child, resolve Credential.OAuth
// 5. timeout/cancel/disposal -> kill child, clear timer; timeout carries
//    manual-login guidance
// 6. superseded      -> a new attempt while one is pending (user abandoned the
//    browser flow and reconnected) first kills the previous child, clears its
//    timer, and rejects its callback with a supersession error, then spawns;
//    `state.auth` is shared, so skipping this step would orphan the previous
//    child (no owner → never killed) and cross-wire the two polls' fields
async function authorize(resources: AuthResources): Promise<OAuthAuthorization> {
  // async probe only — the sync verifyAuth is never imported by the plugin
  const { verifyAuthAsync } = await import("kiro-acp-ai-provider")
  // imported up-front (not at spawn time) on purpose: the supersede check →
  // spawn → cancelPoll claim below must be one synchronous segment. An await
  // between them lets two authorize() calls in the same microtask window both
  // see `cancelPoll === undefined`, then both spawn — two `kiro-cli login`
  // children alive, the first one orphaned.
  const { execFile } = await import("node:child_process")
  const status = await verifyAuthAsync()

  if (!status.installed) throw new Error(NOT_INSTALLED_MESSAGE)

  if (status.authenticated) {
    // already-resolved: no guard needed (a resolved promise cannot leak a rejection)
    return {
      url: KIRO_DOCS_URL,
      instructions: ALREADY_AUTHENTICATED_INSTRUCTIONS,
      mode: "auto",
      callback: Promise.resolve(kiroCredential()),
    }
  }

  // state 6: supersede any in-flight attempt before claiming the shared
  // fields. Rejecting the previous callback here is safe: its derived promise
  // was guarded when it was handed out.
  // Invariant: no await between this check and the cancelPoll claim inside
  // pollForLogin() (which sets `resources.cancelPoll` synchronously).
  if (resources.cancelPoll !== undefined) {
    releaseLoginResources(resources, new Error(SUPERSEDED_MESSAGE))
  }

  // shell:true on win32 so bare "kiro-cli" resolves via PATHEXT to .exe/.cmd
  // (matches the SDK's spawns); shell:false elsewhere
  resources.child = execFile("kiro-cli", ["login"], {
    shell: process.platform === "win32",
  })

  const callback = pollForLogin(verifyAuthAsync, resources)
  // Guard the derived promise: an abandoned login (timeout/cancel) must not
  // surface as an unhandled rejection before the host attaches its handler.
  // The original callback is returned so the host still observes the rejection.
  callback.catch(() => {})
  return { url: KIRO_DOCS_URL, instructions: LOGIN_INSTRUCTIONS, mode: "auto", callback }
}

// upsert Integration `kiro` with the "Kiro CLI Login" OAuth method via
// context.integration.transform. Returns one disposer that releases any
// in-flight login resources and unregisters the transform.
export async function registerAuth(
  context: Plugin.Context,
  resources: AuthResources,
): Promise<() => Promise<void>> {
  const registration = await context.integration.transform((draft) => {
    draft.update(KIRO_INTEGRATION_ID, (integration) => {
      integration.name = KIRO_INTEGRATION_NAME
    })
    // forms shape per installed d.ts IntegrationOAuthMethodRegistration
    // (dist/promise/integration.d.ts). This flow needs no form fields, so the
    // optional `form` is omitted and the Form.Answer argument is unused.
    draft.method.update({
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: KIRO_OAUTH_METHOD_ID,
        type: "oauth",
        label: KIRO_OAUTH_METHOD_LABEL,
      },
      authorize: async (_answer) => authorize(resources),
      // no refresh callback: kiro-cli owns credential storage and refresh
    })
  })
  resources.disposeRegistration = registration.dispose

  return async () => {
    releaseLoginResources(resources)
    resources.disposeRegistration = undefined
    await registration.dispose()
  }
}
