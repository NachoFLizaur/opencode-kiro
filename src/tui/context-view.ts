// Drop-in superset of the builtin `internal:sidebar-context` box: tokens,
// context percent (mirroring the builtin derivation), and a 4th line that
// degrades gracefully. When the session carries Kiro credit metadata it shows
// the credits line; otherwise it shows the builtin's exact "$X spent" line
// (`money.format(session.cost) + " spent"`). Because the builtin is disabled
// globally once this plugin is wired up, this keeps non-kiro sessions looking
// identical to today's builtin instead of a bare "0" credits line.
//
// Built with @opentui/solid's universal-renderer calls (what compiled Solid JSX
// lowers to) so the dist needs no solid transform. @opentui/solid and solid-js
// stay external and are aliased to the host's instances at load time.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createElement, effect, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { spendLines, sumSessionCredits } from "./credits.js"

type ThemeAccessor = () => TuiPluginApi["theme"]["current"]

/** Build the replacement context box for one session. */
export function createContextView(api: TuiPluginApi, sessionID: string): DomNode {
  const theme: ThemeAccessor = () => api.theme.current
  const messages = createMemo(() => api.state.session.messages(sessionID))

  // Mirrors the builtin: latest assistant message with output tokens; percent
  // against that model's context limit.
  const usage = createMemo(() => {
    const last = messages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) {
      return {
        tokens: 0,
        percent: null as number | null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  // Credits roll up across this session's assistant messages, deduped per
  // message (from part.metadata?.kiro).
  const credits = createMemo(() => sumSessionCredits(messages(), (messageID) => api.state.part(messageID)))

  // Builtin fallback: the session-level dollar cost the builtin reads via
  // `api.state.session.get(id).cost`. Kiro is subscription-metered (cost stays
  // $0.00), so this only ever surfaces for non-kiro sessions.
  const cost = createMemo(() => api.state.session.get(sessionID)?.cost ?? 0)

  const root = createElement("box")
  insertNode(root, headerLine(theme))
  insertNode(
    root,
    mutedLine(theme, () => `${usage().tokens.toLocaleString()} tokens`),
  )
  insertNode(
    root,
    mutedLine(theme, () => `${usage().percent ?? 0}% used`),
  )
  // Kiro credits and/or the builtin "$X spent" line: dollars only, credits only,
  // or BOTH (two stacked lines "$X.XX spent" then "N credits") when a session used
  // both in one session. One mutedLine per returned array element; deriving the
  // lines in a memo keeps each row reactive as cost()/credits() change while the
  // row COUNT stays dynamic (1 or 2).
  //
  // The reactive insert gets its OWN child container instead of sharing root.
  // root's other lines are appended imperatively via insertNode, but Solid's
  // reactive insert assumes it owns the parent's child list: with no marker its
  // reconciler falls back to [getFirstChild(parent)] (root's header), so
  // reconcileArrays/cleanChildren would clobber the imperative siblings and the
  // cost subtree throws/renders nothing. A dedicated costBox lets insert fully own
  // its children and render exactly the 1 or 2 rows the memo returns. An empty
  // <text> would NOT collapse to zero height (TextBufferRenderable's measure func
  // floors height to Math.max(1, lineCount)), so a fixed two-row form would leave a
  // visible blank line in the single-row states; the owned container avoids that by
  // rendering one node per array element only.
  const costBox = createElement("box")
  insertNode(root, costBox)
  const costLines = createMemo(() => spendLines({ cost: cost(), credits: credits() }))
  insert(costBox, () => costLines().map((line) => mutedLine(theme, () => line)))
  return root
}

/** `<text fg={theme.text}><b>Context</b></text>` */
function headerLine(theme: ThemeAccessor): DomNode {
  const line = createElement("text")
  effect(() => setProp(line, "fg", theme().text))
  const bold = createElement("b")
  insert(bold, "Context")
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
