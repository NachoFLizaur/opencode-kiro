// credits-only sidebar box appended below the native Context box; it doesn't clone or replace it.
// shows only the session's kiro credits (same helpers as the footer chip); renders empty for non-kiro sessions.
// built with @opentui/solid's universal-renderer calls (what compiled Solid JSX lowers to) so dist needs no solid transform; @opentui/solid and solid-js stay external.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, effect, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

type ThemeAccessor = () => TuiPluginApi["theme"]["current"]

/** Build the Kiro credits box for one session (renders empty for non-kiro sessions). */
export function createCreditsBoxView(api: TuiPluginApi, sessionID: string): DomNode {
  const theme: ThemeAccessor = () => api.theme.current
  const messages = createMemo(() => api.state.session.messages(sessionID))

  // credits roll up across this session's assistant messages, deduped per message, like the footer chip
  const credits = createMemo(() => sumSessionCredits(messages(), (messageID) => api.state.part(messageID)))

  // stable nodes with reactive strings: both render "" with no credits, so the box collapses to nothing.
  // one stable node + reactive string sidesteps opentui child-list reconciliation (version-dependent in the old clone view).
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
