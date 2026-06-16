// Footer credits chip for the session prompt's right slot (session_prompt_right),
// the host's only plugin-registerable slot in the prompt/footer area. It sits in
// the prompt meta row alongside the host's token/context + "$X" cost chips.
//
// Renders "N credits" (same formatCredits as the sidebar) only when the session
// carries Kiro credit metadata; otherwise renders an empty string so non-kiro
// sessions keep the host's "$X" footer chip untouched and never see a kiro chip.
//
// Built with @opentui/solid's universal-renderer calls (compiled-Solid lowering)
// so dist needs no solid transform; @opentui/solid and solid-js stay external.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, effect, insert, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

/** Build the footer credits chip for one session. */
export function createCreditsChipView(api: TuiPluginApi, sessionID: string): DomNode {
  const messages = createMemo(() => api.state.session.messages(sessionID))
  const credits = createMemo(() => sumSessionCredits(messages(), (messageID) => api.state.part(messageID)))

  // `wrapMode="none"` + `theme.textMuted` mirrors the host cost/token chip
  // (prompt/index.tsx). Empty content collapses to zero width, i.e. nothing.
  const chip = createElement("text")
  effect(() => setProp(chip, "fg", api.theme.current.textMuted))
  setProp(chip, "wrapMode", "none")
  insert(chip, () => (credits().present ? formatCredits(credits().total, credits().unit) : ""))
  return chip
}
