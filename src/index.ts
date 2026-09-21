/** OpenCode V2 server plugin. */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-kiro",
  async setup(ctx) {
    // `kiro-acp-ai-provider` owns the kiro-cli connection and authentication.
    // Models come from OpenCode's provider catalog/config; this transform only
    // supplies the ACP runtime settings shared by every Kiro model.
    await ctx.provider.transform((editor) => {
      if (!editor.get("kiro")) return

      editor.update("kiro", (entry) => {
        entry.settings = {
          ...entry.settings,
          cwd: ctx.location.directory,
          agent: "opencode",
          trustAllTools: true,
          mcpTimeout: 45,
        }
      })
    })
  },
})
