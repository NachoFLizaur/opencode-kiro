import { defineConfig } from "tsup"

export default defineConfig({
  entry: { server: "src/server.ts", tui: "src/tui.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  // The host (opencode) provides the plugin API and TUI runtime; the SDK is
  // resolved separately by opencode's resolveSDK. None of these may be bundled.
  external: [
    "@opencode-ai/plugin",
    "kiro-acp-ai-provider",
    "@opentui/core",
    "@opentui/keymap",
    "@opentui/solid",
    "solid-js",
  ],
})
