import { Plugin } from "@opencode/plugin/tui"
import { createElement, insert, insertNode, setProp } from "@opentui/solid"
import { createMemo } from "solid-js"
import { formatCredits, sumSessionCredits } from "./credits.js"

/** OpenCode V2 terminal plugin: show Kiro credits in the session sidebar. */
export default Plugin.define({
  id: "opencode-kiro",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const credits = createMemo(() =>
          sumSessionCredits(context.data.session.message.list(sessionID), (messageID) => {
            const message = context.data.session.message.get(sessionID, messageID)
            return message?.type === "assistant" ? message.content : []
          }),
        )

        const box = createElement("box")
        const header = createElement("text")
        const amount = createElement("text")
        setProp(header, "fg", context.theme.text.base)
        setProp(amount, "fg", context.theme.text.muted)
        insert(header, () => (credits().present ? "Kiro" : ""))
        insert(amount, () => (credits().present ? formatCredits(credits().total, credits().unit) : ""))
        insertNode(box, header)
        insertNode(box, amount)
        return box
      },
    })
  },
})
