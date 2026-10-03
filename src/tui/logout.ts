// Logout dialog for the TUI: reacts to the `kiroLoggedOut` flag the server plugin writes on the
// kiro integration's metadata (`{ stage: "suspected" | "confirmed" }`, absent when logged in).
// The server detects the logout; this module offers the reconnect and removes the stale
// credential so the host hides Kiro models until the user reconnects.
//
// Unlocated `integration.updated` events are not invalidated by the host's data layer.
// Invalidate the resolved location before syncing; otherwise sync can hit the stale cache.
//
// One "episode" runs from the first flagged `integration.updated` to the first unflagged one,
// tracked per location:
//   - `suspected`: show the confirm dialog once. Confirm removes every kiro credential connection
//     and opens the connect flow; cancel (or dismiss) does nothing now.
//   - `confirmed`: remove the remaining credential connections (once), and show the dialog only
//     if it was not shown yet in this episode.
//   - flag absent: forget the episode so the next logout prompts again.
// Event handling is serialized per location so rapid resyncs cannot double-prompt or
// double-remove; the dialog itself is never awaited on that chain, so a `confirmed` update that
// arrives while the dialog is open still removes the credential right away. Nothing here throws
// into the host's event dispatch, and no opentui/solid import keeps it plain-Node testable.

/** Dialog title shown when the server suspects or confirms a kiro-cli logout. */
export const LOGOUT_DIALOG_TITLE = "Kiro CLI is logged out"
/** Dialog message; confirming removes the stale credential and opens the connect flow. */
export const LOGOUT_DIALOG_MESSAGE = "Reconnect now?"
/** Integration id the server plugin registers for Kiro. */
export const KIRO_INTEGRATION_ID = "kiro"
/** Host command that opens the connect dialog (the `/connect` command). */
export const PROVIDER_CONNECT_COMMAND = "provider.connect"

/** Stages the server plugin writes; any other value reads as "not logged out". */
export type LogoutStage = "suspected" | "confirmed"

/** Structural `LocationRef` (client shape): a directory plus an optional workspace id. */
export interface LogoutLocation {
  readonly directory: string
  readonly workspaceID?: string
}

/** Structural subset of the host's `IntegrationInfo` this module reads. */
export interface LogoutIntegration {
  readonly id: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly connections: ReadonlyArray<{ readonly type: string; readonly id?: string }>
}

/** Structural subset of the TUI plugin context this module uses. */
export interface LogoutContext {
  readonly location: LogoutLocation | undefined
  readonly client: {
    readonly credential: {
      remove(input: { readonly credentialID: string }): Promise<unknown>
    }
  }
  readonly data: {
    readonly location: {
      readonly integration: {
        invalidate(location?: LogoutLocation): void
        sync(location?: LogoutLocation): Promise<void>
        list(location?: LogoutLocation): ReadonlyArray<LogoutIntegration> | undefined
      }
    }
  }
  readonly ui: {
    readonly dialog: {
      confirm(options: { readonly title: string; readonly message: string }): Promise<boolean | undefined>
    }
  }
  readonly keymap: {
    dispatch(id: string): void
  }
}

/** `integration.updated` payload subset: the event may carry the location it belongs to. */
export interface IntegrationUpdatedEvent {
  readonly location?: LogoutLocation
}

/** Handler to pass to `data.on("integration.updated", ...)` plus a disposer for TUI cleanup. */
export interface LogoutWatcher {
  readonly handle: (event: IntegrationUpdatedEvent) => void
  readonly dispose: () => void
}

/** Per-location episode state; dropped when the flag clears so the next logout re-arms. */
interface Episode {
  dialogShown: boolean
  /** In-flight or finished removal of this episode's credential connections (runs once). */
  removal?: Promise<void>
}

/** Read `metadata.kiroLoggedOut.stage` off the kiro integration; undefined for anything else. */
export function readLogoutStage(integrations: ReadonlyArray<LogoutIntegration> | undefined): LogoutStage | undefined {
  const kiro = integrations?.find((integration) => integration.id === KIRO_INTEGRATION_ID)
  const flag: unknown = kiro?.metadata?.kiroLoggedOut
  if (typeof flag !== "object" || flag === null) return undefined
  const stage = (flag as Record<string, unknown>).stage
  return stage === "suspected" || stage === "confirmed" ? stage : undefined
}

/** Credential connection ids of the kiro integration (env connections are not removable). */
export function kiroCredentialIDs(integrations: ReadonlyArray<LogoutIntegration> | undefined): string[] {
  const kiro = integrations?.find((integration) => integration.id === KIRO_INTEGRATION_ID)
  if (!kiro) return []
  return kiro.connections
    .filter((connection) => connection.type === "credential" && typeof connection.id === "string")
    .map((connection) => connection.id as string)
}

function locationKey(location: LogoutLocation | undefined): string {
  return location ? `${location.directory}\u0000${location.workspaceID ?? ""}` : ""
}

/**
 * Build the `integration.updated` watcher. `handle` never throws and never rejects; every
 * failure (invalidate, sync, list, dialog, removal, dispatch) is swallowed so host event dispatch is safe.
 */
export function createLogoutWatcher(context: LogoutContext): LogoutWatcher {
  const episodes = new Map<string, Episode>()
  const chains = new Map<string, Promise<void>>()
  let disposed = false

  const removeCredentials = async (location: LogoutLocation | undefined): Promise<void> => {
    const ids = kiroCredentialIDs(context.data.location.integration.list(location))
    for (const credentialID of ids) {
      try {
        // Credentials are global; only the integration read is location-scoped.
        await context.client.credential.remove({ credentialID })
      } catch {
        // ignore - an unknown id is a host no-op, and one failed removal must not block the others
      }
    }
  }

  /** Runs the episode's removal once; later callers await the same promise. */
  const ensureRemoved = (episode: Episode, location: LogoutLocation | undefined): Promise<void> => {
    episode.removal ??= removeCredentials(location)
    return episode.removal
  }

  const showDialog = async (key: string, episode: Episode, location: LogoutLocation | undefined): Promise<void> => {
    const answer = await context.ui.dialog.confirm({ title: LOGOUT_DIALOG_TITLE, message: LOGOUT_DIALOG_MESSAGE })
    // the episode may have ended (user logged back in) or the TUI may be gone while the dialog was open
    if (answer !== true || disposed || episodes.get(key) !== episode) return
    await ensureRemoved(episode, location)
    if (disposed) return
    context.keymap.dispatch(PROVIDER_CONNECT_COMMAND)
  }

  const processUpdate = async (event: IntegrationUpdatedEvent): Promise<void> => {
    const location = event?.location ?? context.location
    const key = locationKey(location)
    context.data.location.integration.invalidate(location)
    await context.data.location.integration.sync(location)
    if (disposed) return
    const stage = readLogoutStage(context.data.location.integration.list(location))
    if (stage === undefined) {
      episodes.delete(key)
      return
    }
    let episode = episodes.get(key)
    if (!episode) {
      episode = { dialogShown: false }
      episodes.set(key, episode)
    }
    if (stage === "confirmed") await ensureRemoved(episode, location)
    if (disposed || episodes.get(key) !== episode || episode.dialogShown) return
    episode.dialogShown = true
    // not awaited: the dialog waits on the user, while later updates keep flowing
    void showDialog(key, episode, location).catch(() => {
      // ignore - dialog or removal failures never surface to the host
    })
  }

  const handle = (event: IntegrationUpdatedEvent): void => {
    if (disposed) return
    const key = locationKey(event?.location ?? context.location)
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => processUpdate(event))
      .catch(() => {
        // ignore - a failed update must never break host event dispatch or the chain
      })
    chains.set(key, next)
  }

  const dispose = (): void => {
    disposed = true
    episodes.clear()
    chains.clear()
  }

  return { handle, dispose }
}
