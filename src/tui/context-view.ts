// Full-replacement sidebar context box: tokens + context percent (mirroring
// the builtin `internal:sidebar-context` derivation exactly) + a Kiro credits
// line summed from persisted part metadata.
//
// Authored programmatically against @opentui/solid's universal-renderer
// exports (createElement/insert/insertNode/setProp/effect) — precisely the
// calls compiled Solid JSX lowers to — so the published dist needs no
// babel/solid transform at build or load time. The bare `@opentui/solid` and
// `solid-js` imports stay external (tsup config) and are aliased to the TUI
// HOST's own module instances at load time by opencode's runtime plugin
// support, keeping reactivity on the host's reactive system.
//
// Builtin layout being mirrored (packages/tui/src/feature-plugins/sidebar/
// context.tsx):
//
//   <box>
//     <text fg={theme.text}><b>Context</b></text>
//     <text fg={theme.textMuted}>{tokens.toLocaleString()} tokens</text>
//     <text fg={theme.textMuted}>{percent ?? 0}% used</text>
//     <text fg={theme.textMuted}>{money.format(cost)} spent</text>
//   </box>
//
// The "$X spent" line is replaced by the credits line: Kiro is
// subscription-metered, so dollar cost is always $0.00 there — credits are
// the meaningful spend signal (user requirement #6's TUI-sidebar stopgap).
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createElement, effect, insert, insertNode, setProp, type DomNode } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

type ThemeAccessor = () => TuiPluginApi["theme"]["current"]

/**
 * Build the replacement context box for one session. Returned renderable is
 * a valid `sidebar_content` slot element (JSX.Element = DomNode for the
 * universal renderer).
 */
export function createContextView(api: TuiPluginApi, sessionID: string): DomNode {
  const theme: ThemeAccessor = () => api.theme.current
  const messages = createMemo(() => api.state.session.messages(sessionID))

  // Token/percent derivation mirrors the builtin: latest assistant message
  // with output tokens; percent against that model's context limit, resolved
  // through api.state.provider.
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

  // Credits roll up across the CURRENT session's assistant messages only,
  // deduped per message by the pure helpers (`part.metadata?.kiro?.credits`).
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
