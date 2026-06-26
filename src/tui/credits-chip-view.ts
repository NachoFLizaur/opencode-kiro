// footer credits chip for session_prompt_right (the host's only registerable prompt/footer slot), beside the host's token/cost chips.
// renders "N credits" only when the session carries kiro metadata, else "" so non-kiro sessions keep the host's "$X" chip untouched.
// built with @opentui/solid's universal-renderer calls (compiled-Solid lowering) so dist needs no solid transform; @opentui/solid and solid-js stay external.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, effect, insert, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

/** Build the footer credits chip for one session. */
export function createCreditsChipView(api: TuiPluginApi, sessionID: string): DomNode {
  const messages = createMemo(() => api.state.session.messages(sessionID))
  const credits = createMemo(() => sumSessionCredits(messages(), (messageID) => api.state.part(messageID)))

  // wrapMode="none" + theme.textMuted mirrors the host cost/token chip (prompt/index.tsx); empty content collapses to zero width
  const chip = createElement("text")
  effect(() => setProp(chip, "fg", api.theme.current.textMuted))
  setProp(chip, "wrapMode", "none")
  insert(chip, () => (credits().present ? formatCredits(credits().total, credits().unit) : ""))
  return chip
}
