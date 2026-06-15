// TUI plugin module. Registers a sidebar_content view (order 100) that fully
// replaces the builtin `internal:sidebar-context` box (tokens, context %, Kiro
// credits). Users disable the builtin via tui.json
// (plugin_enabled: {"internal:sidebar-context": false}), else both render.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// Lazy import: @opentui/core is Bun-native and only exists in the opencode TUI
// host, so importing the view here keeps dist/tui.js loadable under plain Node.
const tui: TuiPlugin = async (api) => {
  const { createContextView } = await import("./tui/context-view.js")
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return createContextView(api, props.session_id)
      },
    },
  })
}

// `id` is required for path/file-source installs (opencode rejects file-source
// plugins without one). Matching the package name keeps the id, and your
// plugin_enabled keys, identical across path and npm installs.
export default { id: "opencode-kiro", tui }

// Pure helpers re-exported for unit tests; named exports don't affect the loader.
export {
  creditsForMessage,
  formatCredits,
  messageCredits,
  readPartCredits,
  sumSessionCredits,
  type CreditMessage,
  type CreditPart,
  type PartCredits,
  type SessionCredits,
} from "./tui/credits.js"
