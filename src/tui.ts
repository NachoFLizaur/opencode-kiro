// TUI plugin: appends a Kiro credits box below the native Context box, replaces nothing.
//   - sidebar_content (order 150): credits-only box. builtin sections render by order (context=100, mcp=200), so 150 lands it below Context. empty for non-kiro.
//   - session_prompt_right: footer credits chip beside the host's cost/token chips, kiro sessions only.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// lazy import: @opentui/core is Bun-native and only exists in the TUI host, so this keeps dist/tui.js loadable under plain Node
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

// `id` is required for file-source installs (opencode rejects them without one); matching the package name keeps it identical across path and npm installs
export default { id: "opencode-kiro", tui }

// pure helpers re-exported for tests; named exports don't affect the loader
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
