// Full replacement for the builtin `internal:sidebar-context` box: tokens,
// context percent (mirroring the builtin derivation), and a Kiro credits line
// in place of the builtin "$X spent" (Kiro is subscription-metered, so dollar
// cost is always $0.00).
//
// Built with @opentui/solid's universal-renderer calls (what compiled Solid JSX
// lowers to) so the dist needs no solid transform. @opentui/solid and solid-js
// stay external and are aliased to the host's instances at load time.
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createElement, effect, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

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
  insertNode(
    root,
    mutedLine(theme, () => formatCredits(credits().total, credits().unit)),
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
