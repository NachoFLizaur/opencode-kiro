// TUI plugin module (opencode TuiPluginModule: { id?, tui, server?: never }).
// The loader requires `tui` to be a FUNCTION and rejects modules exporting
// both `tui` and `server` (opencode shared.ts:287-295) — this module never
// exports a `server` key.
//
// The registered sidebar_content view (order 100, the builtins' order) is a
// FULL REPLACEMENT for the builtin `internal:sidebar-context` box: tokens +
// context percent + a Kiro credits line. Disabling the builtin is a USER step
// (`tui.json → plugin_enabled: {"internal:sidebar-context": false}`, README /
// task 12); until then both boxes render — cosmetic duplication, not a defect.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// The view module is imported lazily so dist/tui.js carries no top-level
// @opentui/solid import: @opentui/core is Bun-native and only exists inside
// the opencode TUI host (which aliases bare @opentui/*/solid-js specifiers to
// its own instances). This keeps the module importable under plain node for
// shape checks and keeps the pure credit helpers usable without a TUI
// runtime.
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

// `id` is REQUIRED for path/file installs: opencode's TUI runtime resolves a
// plugin id via resolvePluginId (plugin/shared.ts:306-316), which THROWS
// "Path plugin <spec> must export id" for file-source specs whose module
// doesn't export one (npm-source specs fall back to the package name).
// "opencode-kiro" matches the package name so the id is identical across
// path and npm installs — keeping `plugin_enabled` keys and the plugin
// manager UI stable for both install modes.
export default { id: "opencode-kiro", tui }

// Pure helpers re-exported for unit tests (task 09) and validation commands.
// Named exports never affect the plugin loader — it reads only the default
// export (shared.ts readV1Plugin).
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
