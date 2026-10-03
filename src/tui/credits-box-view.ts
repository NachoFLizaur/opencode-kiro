// credits sidebar box for the `sidebar.content` slot, claimed with `append` so it composes
// after the built-in sections and never replaces host content. The formatted total + unit
// line under the "Kiro" header updates live as durable/transient credits change; a compact
// companion chip (credits-chip-view.ts) carries the same total in the prompt footer row.
// Presentation only: tui.ts assembles the merged durable+transient rollup and passes it in as
// an accessor plus optional feature-detected `context.theme` tokens; this module never touches
// the TUI context. With no tokens (absent or misshapen theme), nothing sets foreground colors
// and the terminal/host defaults apply — rendering never depends on the theme.
// built with @opentui/solid's universal-renderer calls (what compiled Solid JSX lowers to)
// so dist needs no solid transform; @opentui/solid and solid-js stay external (and, inside
// the TUI host, resolve to the host's module instances via its runtime-plugin loader shim).
import type { ColorInput } from "@opentui/core"
import { createElement, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, type SessionCredits } from "./credits.js"

/**
 * Feature-detected `context.theme` colors for the credits views (validated by tui.ts from
 * `theme.text.base` / `theme.text.muted`). Every field is optional: an absent token
 * means "leave the default/inherited styling alone".
 */
export interface CreditThemeTokens {
  /** Header foreground (`theme.text.base`). */
  readonly default?: ColorInput
  /** Amount/chip foreground (`theme.text.muted`). */
  readonly subdued?: ColorInput
}

/**
 * Build the Kiro credits box for one session. `credits` is the merged durable+transient
 * session rollup assembled in tui.ts (reconciled on every fresh durable read); `tokens` are
 * the optional feature-detected theme colors.
 */
export function createCreditsBoxView(credits: () => SessionCredits, tokens?: CreditThemeTokens): DomNode {
  const current = createMemo(credits)

  // stable nodes with reactive strings: both render "" with no credits, so the box collapses
  // to nothing (tui.ts additionally withholds the node entirely for credit-less sessions).
  // one stable node + reactive string sidesteps opentui child-list reconciliation
  // (version-dependent in the old clone view).
  const root = createElement("box")
  insertNode(
    root,
    headerLine(() => (current().present ? "Kiro" : ""), tokens?.default),
  )
  insertNode(
    root,
    plainLine(() => (current().present ? formatCredits(current().total, current().unit) : ""), tokens?.subdued),
  )
  return root
}

/** `<text fg?><b>{content()}</b></text>` — bold header; themed foreground when a token exists. */
function headerLine(content: () => string, fg?: ColorInput): DomNode {
  const line = createElement("text")
  if (fg !== undefined) setProp(line, "fg", fg)
  const bold = createElement("b")
  insert(bold, content)
  insertNode(line, bold)
  return line
}

/** `<text fg?>{content()}</text>` — themed foreground when a token exists, else inherited/default. */
function plainLine(content: () => string, fg?: ColorInput): DomNode {
  const line = createElement("text")
  if (fg !== undefined) setProp(line, "fg", fg)
  insert(line, content)
  return line
}
