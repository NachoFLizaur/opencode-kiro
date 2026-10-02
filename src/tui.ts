// TUI plugin: appends the Kiro credits surfaces and replaces nothing. Two additive slot
// claims: `sidebar.content` (credits box: "Kiro" header + formatted total) and
// `prompt.footer.status` (compact chip with the same total + unit, after the host's status
// content). Both add a one-line stall summary when the last completed turn stalled. Credits
// and status come from durable messages via `context.data.session.message.list` plus a
// transient store fed by `session.text.ended` and `session.reasoning.ended` events: the host's
// live reducer drops `event.data.state` for text-only responses, so the transient store is a
// live overlay and the durable value wins on reconcile. `context.data.session.message.sync` is
// never forced.
//
// Lazy-import rule: @opentui/core is Bun-native and only exists inside the TUI host, so the
// view modules and solid-js are imported inside setup — never at module top level — keeping
// dist/tui.js loadable under plain Node. The host loader redirects `solid-js`/`@opentui/*`
// imports to its own module instances, so the reactivity below shares the host's solid runtime.
//
// Types: `sessionID` is required on `sidebar.content` but optional on `prompt.footer.status`
// (the chip is withheld when absent). `@opencode-ai/theme` is an uninstalled peer, so
// `context.theme` tokens are feature-detected at render time.
import type { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { CreditThemeTokens } from "./tui/credits-box-view.js"
import type { SessionCredits } from "./tui/credits.js"
import {
  clear,
  createTransientStore,
  mergedMessageCredits,
  reconcile,
  recordTextEnded,
  type TextEndedEvent,
  type TransientCreditStore,
} from "./tui/transient-credits.js"

const EMPTY_CREDITS: SessionCredits = { total: 0, unit: undefined, present: false }

/**
 * Slot props carry a sessionID (typed via `SlotMap`; required on `sidebar.content`, optional
 * on `prompt.footer.status`); treat anything else as "no session".
 */
function readSessionID(props: { readonly sessionID?: unknown }): string | undefined {
  const sessionID = props.sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined
}

/** Accept a color token only in a shape opentui's `fg` takes: non-empty string or object (RGBA). */
function readColorToken(value: unknown): CreditThemeTokens["default"] {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "object" && value !== null) return value as CreditThemeTokens["default"]
  return undefined
}

/**
 * Feature-detect `context.theme` tokens (`theme.text.default` / `theme.text.subdued` per the
 * ResolvedTheme shape). Returns undefined for an absent/misshapen theme so the views keep
 * their default styling — rendering never depends on the theme.
 */
function readThemeTokens(theme: unknown): CreditThemeTokens | undefined {
  if (typeof theme !== "object" || theme === null) return undefined
  const text = (theme as Record<string, unknown>).text
  if (typeof text !== "object" || text === null) return undefined
  const tokens = text as Record<string, unknown>
  const defaultFg = readColorToken(tokens.default)
  const subduedFg = readColorToken(tokens.subdued)
  if (defaultFg === undefined && subduedFg === undefined) return undefined
  return { default: defaultFg, subdued: subduedFg }
}

// setup returns one aggregated, idempotent cleanup: the first call marks the instance
// disposed, attempts every disposer (reverse registration order) even when one fails, then
// reports combined failures via AggregateError; later calls are no-ops.
const plugin: Plugin.Definition = {
  // `id` is required for file-source installs (opencode rejects them without one);
  // matching the package name keeps it identical across path and npm installs
  id: "opencode-kiro",
  async setup(context: Plugin.Context): Promise<Plugin.Cleanup> {
    const disposers: Array<() => void | Promise<void>> = []
    let disposed = false

    // transient store: hosted in TUI `storage.memory` when available so the live-overlay
    // credits survive plugin hot reloads (`tui: true` installs) — solid stores leave Map values
    // unwrapped, so the store's pure API in transient-credits.ts is unchanged. A memory-backed
    // store is shared with the next plugin generation and therefore intentionally not cleared
    // on cleanup; the fallback per-setup store is cleared (registered first so the
    // reverse-order cleanup clears it last, after slots and listeners are gone).
    const memoryStore = context.storage?.memory?.<TransientCreditStore>("transient-credits", {
      initial: createTransientStore(),
    })
    const store: TransientCreditStore = memoryStore ? memoryStore[0] : createTransientStore()
    if (!memoryStore) disposers.push(() => clear(store))

    // lazy import (see the lazy-import rule above): the view modules pull Bun-native
    // @opentui/core transitively, so they load only when the TUI host runs setup.
    const [{ createCreditsBoxView }, { createCreditsChipView }, { createSignal }] = await Promise.all([
      import("./tui/credits-box-view.js"),
      import("./tui/credits-chip-view.js"),
      import("solid-js"),
    ])

    // Transient writes go into a plain Map (not reactive); this signal makes render-path
    // reads re-run after an ended-part record, independent of host reducer ordering.
    const [transientVersion, setTransientVersion] = createSignal(0)

    // Credits and the stall status ride the ended event of whichever part closes the turn:
    // normally the last text part, but when a stall notice is still open at turn end the SDK
    // closes that reasoning part and attaches the metadata there instead. Both event kinds share
    // one data shape and one never-throw recording path: invalid payloads are swallowed by
    // recordTextEnded's guards, and anything unexpected is ignored here.
    const recordEnded = (event: TextEndedEvent): void => {
      try {
        recordTextEnded(store, event)
        setTransientVersion((version) => version + 1)
      } catch {
        // ignore — a bad event must never break host event dispatch
      }
    }
    disposers.push(context.data.on("session.text.ended", recordEnded))
    disposers.push(context.data.on("session.reasoning.ended", recordEnded))

    // Render-path data assembly (views stay presentation-only): every fresh durable read
    // reconciles the transient store first, so durable state stays authoritative and
    // totals never count a transient and durable copy together.
    const creditsFor =
      (sessionID: string | undefined) =>
      (): SessionCredits => {
        if (!sessionID) return EMPTY_CREDITS
        transientVersion()
        const messages = context.data.session.message.list(sessionID) ?? []
        reconcile(store, sessionID, messages)
        return mergedMessageCredits(store, sessionID, messages)
      }

    // Both claims return a reactive accessor that yields the view node only while the
    // session carries Kiro credit data, so non-kiro sessions contribute nothing.
    // Deviation note: the installed SlotClaim render type's JSX.Element union does not
    // structurally include opentui DomNodes or function children, but the host's universal
    // renderer resolves both — hence the boundary cast.
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const credits = creditsFor(readSessionID(props))
        const view = createCreditsBoxView(credits, readThemeTokens(context.theme))
        return (() => (credits().present ? view : null)) as unknown as JSX.Element
      },
    })
    disposers.push(unregisterSidebar)

    // Chip placement: the host mounts `prompt.footer.status` inside a `flexDirection="row"
    // gap={2}` footer box and `Slot` renders claims as fragment siblings, so the chip sits
    // beside the host status content with the row gap as its separator (no separator text
    // needed). `sessionID` is optional in `PromptFooterInput` — readSessionID + creditsFor
    // already yield EMPTY_CREDITS then, so the chip is withheld exactly like a credit-less
    // session. `mode` ("normal" | "shell") is deliberately ignored: the chip renders in
    // both modes — the host footer children don't change by mode, the chip is a short
    // non-shrinking string next to a flexGrow/flexShrink host box, and collapsing on
    // shell toggle would only cause a layout jump.
    const unregisterChip = context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const credits = creditsFor(readSessionID(props))
        const view = createCreditsChipView(credits, readThemeTokens(context.theme))
        return (() => (credits().present ? view : null)) as unknown as JSX.Element
      },
    })
    disposers.push(unregisterChip)

    return async () => {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "opencode-kiro tui cleanup failures")
    }
  },
}

export default plugin
