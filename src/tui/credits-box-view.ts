// Credits-only sidebar box, appended below the native Context box. It does NOT
// clone or replace the builtin Context sidebar box: the native box
// stays enabled and keeps showing tokens, context percent, and the "$X spent"
// cost line. This box shows ONLY the Kiro credits for the session, reusing the
// same credit helpers the footer chip uses. For a non-kiro session it renders
// empty (no header, no line), so it adds nothing to that session's sidebar.
//
// Built with @opentui/solid's universal-renderer calls (what compiled Solid JSX
// lowers to) so the dist needs no solid transform. @opentui/solid and solid-js
// stay external and are aliased to the host's instances at load time.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, effect, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

type ThemeAccessor = () => TuiPluginApi["theme"]["current"]

/** Build the Kiro credits box for one session (renders empty for non-kiro sessions). */
export function createCreditsBoxView(api: TuiPluginApi, sessionID: string): DomNode {
  const theme: ThemeAccessor = () => api.theme.current
  const messages = createMemo(() => api.state.session.messages(sessionID))

  // Credits roll up across this session's assistant messages, deduped per
  // message (from part.metadata?.kiro), exactly like the footer chip.
  const credits = createMemo(() => sumSessionCredits(messages(), (messageID) => api.state.part(messageID)))

  // Stable nodes carrying REACTIVE STRINGS: both the header and the credits line
  // render "" when the session has no kiro credits, so the whole box collapses to
  // nothing (the same gating the chip uses, where empty content collapses away).
  // One stable node + reactive string sidesteps opentui child-list reconciliation,
  // which the old context-clone view documented as opentui-version dependent.
  const root = createElement("box")
  insertNode(
    root,
    headerLine(theme, () => (credits().present ? "Kiro" : "")),
  )
  insertNode(
    root,
    mutedLine(theme, () => (credits().present ? formatCredits(credits().total, credits().unit) : "")),
  )
  return root
}

/** `<text fg={theme.text}><b>{content()}</b></text>` */
function headerLine(theme: ThemeAccessor, content: () => string): DomNode {
  const line = createElement("text")
  effect(() => setProp(line, "fg", theme().text))
  const bold = createElement("b")
  insert(bold, content)
  insertNode(line, bold)
  return line
}

/** `<text fg={theme.textMuted}>{content()}</text>` */
function mutedLine(theme: ThemeAccessor, content: () => string): DomNode {
  const line = createElement("text")
  effect(() => setProp(line, "fg", theme().textMuted))
  insert(line, content)
  return line
}
