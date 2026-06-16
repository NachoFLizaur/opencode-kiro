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
import { formatCredits, sumSessionCredits } from "./credits.js"

// Mirrors the builtin's formatter exactly (context.tsx): style currency, USD.
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

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
  // Kiro credits when present; otherwise the builtin's exact "$X spent" line.
  insertNode(
    root,
    mutedLine(theme, () =>
      credits().present ? formatCredits(credits().total, credits().unit) : `${money.format(cost())} spent`,
    ),
  )
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
