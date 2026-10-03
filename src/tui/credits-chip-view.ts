// compact credits chip for the `prompt.footer.status` slot: rendered inline in the prompt
// footer row. The host mounts the slot inside a `flexDirection="row" gap={2}` footer box and
// renders append claims as fragment siblings, so the chip sits beside the host status content
// (spinner / interrupt / location label) with the row gap as its separator — no leading
// separator text is needed. `append` claims are additive, so the chip composes with host
// content and never replaces it.
// Presentation only: tui.ts assembles the merged durable+transient rollup and passes it in
// as an accessor plus optional feature-detected theme tokens; this module never touches the
// TUI context. With no tokens, default/inherited styling applies.
// built with @opentui/solid's universal-renderer calls (compiled-Solid lowering) so dist
// needs no solid transform; @opentui/solid and solid-js stay external (and, inside the TUI
// host, resolve to the host's module instances via its runtime-plugin loader shim).
import { createElement, insert, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import type { CreditThemeTokens } from "./credits-box-view.js"
import { creditsChipText, type SessionCredits } from "./credits.js"

/**
 * Build the prompt-footer credits chip for one session. `credits` is the merged
 * durable+transient session rollup assembled in tui.ts; `tokens` are the optional
 * feature-detected theme colors (`subdued` is fed from the host's `text.muted`).
 */
export function createCreditsChipView(credits: () => SessionCredits, tokens?: CreditThemeTokens): DomNode {
  const current = createMemo(credits)

  // height-bounded single line: explicit height 1 + wrapMode "none" mean the chip can never
  // grow the footer row beyond one row; empty content renders "" (collapse-to-empty), and
  // tui.ts additionally withholds the node entirely for credit-less (non-kiro) sessions.
  // flexShrink 0 keeps the short credits string intact under narrow widths — the host's
  // status box beside it is flexGrow/flexShrink 1 with minWidth 0 and absorbs the squeeze.
  const chip = createElement("text")
  setProp(chip, "height", 1)
  setProp(chip, "wrapMode", "none")
  setProp(chip, "flexShrink", 0)
  if (tokens?.subdued !== undefined) setProp(chip, "fg", tokens.subdued)
  insert(chip, () => creditsChipText(current()))
  return chip
}
