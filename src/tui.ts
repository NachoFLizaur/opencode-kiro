// TUI plugin module (opencode TuiPluginModule: { id?, tui, server?: never }).
// The loader requires `tui` to be a FUNCTION (non-function exports are
// rejected). Real sidebar/credits UI lands in task 08. This module must
// NEVER export a `server` key — the loader rejects modules exporting both
// kinds.
const tui = async () => {}

export default { tui }
