// TUI plugin module. Appends a Kiro credits box below the native Context box;
// it does not disable or replace any builtin sidebar section.
//   - sidebar_content (order 150): a small CREDITS-ONLY box. Builtin sections
//     render by order (context=100, mcp=200, ...), so 150 lands it right below
//     the native Context box. Empty for non-kiro sessions.
//   - session_prompt_right: a footer credits chip beside the host's cost/token
//     chips, shown only for kiro sessions.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// Lazy import: @opentui/core is Bun-native and only exists in the opencode TUI
// host, so importing the views here keeps dist/tui.js loadable under plain Node.
const tui: TuiPlugin = async (api) => {
  const { createCreditsBoxView } = await import("./tui/credits-box-view.js")
  const { createCreditsChipView } = await import("./tui/credits-chip-view.js")
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return createCreditsBoxView(api, props.session_id)
      },
      session_prompt_right(_ctx, props) {
        return createCreditsChipView(api, props.session_id)
      },
    },
  })
}

// `id` is required for path/file-source installs (opencode rejects file-source
// plugins without one). Matching the package name keeps the id identical across
// path and npm installs.
export default { id: "opencode-kiro", tui }

// Pure helpers re-exported for unit tests; named exports don't affect the loader.
export {
  creditsForMessage,
  formatCredits,
  messageCredits,
  readPartCredits,
  spendLines,
  sumSessionCredits,
  type CreditMessage,
  type CreditPart,
  type PartCredits,
  type SessionCredits,
} from "./tui/credits.js"
