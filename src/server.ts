import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

// Auth-only server plugin: the kiro provider/model catalog lives on models.dev,
// so this only supplies the `auth` hook. Must never export `tui` (the loader
// rejects modules exporting both kinds).
const server = async (input: PluginInput): Promise<Hooks> => ({
  auth: {
    provider: "kiro",
    // Returned options are forwarded into createKiroAcp({...}). Relays each
    // catalog model's limit.context into contextWindows keyed by api.id;
    // zero/missing limits are skipped (SDK falls back to 1M).
    loader: async (_getAuth, provider) => ({
      cwd: input.directory ?? input.worktree,
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
      contextWindows: Object.fromEntries(
        Object.values(provider.models)
          .filter((m) => (m.limit?.context ?? 0) > 0)
          .map((m) => [m.api.id, m.limit.context]),
      ),
    }),
    methods: [
      {
        type: "oauth" as const,
        label: "Kiro CLI Login",
        async authorize() {
          const { verifyAuth } = await import("kiro-acp-ai-provider")
          const status = verifyAuth()

          if (!status.installed)
            throw new Error(
              "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/",
            )

          // Already authed: return immediately
          if (status.authenticated) {
            return {
              url: "",
              instructions: "",
              method: "auto" as const,
              async callback() {
                return readToken(status.tokenPath)
              },
            }
          }

          // Not authed: launch kiro-cli login and poll
          const { execFile } = await import("node:child_process")
          const child = execFile("kiro-cli", ["login"])

          return {
            url: "",
            instructions:
              "Complete Kiro authentication in the browser window that just opened. Waiting for login...",
            method: "auto" as const,
            async callback() {
              // Poll until authed (login runs in the background)
              const maxWait = 120_000
              const start = Date.now()
              while (Date.now() - start < maxWait) {
                await new Promise((r) => setTimeout(r, 2000))
                const check = verifyAuth()
                if (check.authenticated) {
                  child.kill()
                  return readToken(check.tokenPath)
                }
              }
              child.kill()
              throw new Error(
                "Kiro authentication timed out. Run `kiro-cli auth login` manually.",
              )
            },
          }
        },
      },
    ],
  },
})

async function readToken(tokenPath: string | undefined) {
  if (tokenPath) {
    try {
      const { readFileSync } = await import("node:fs")
      const raw = JSON.parse(readFileSync(tokenPath, "utf8"))
      return {
        type: "success" as const,
        refresh: "",
        access: raw.accessToken || "authenticated",
        expires: raw.expiresAt
          ? new Date(raw.expiresAt).getTime()
          : Date.now() + 3600000,
      }
    } catch {
      return { type: "failed" as const }
    }
  }
  return {
    type: "success" as const,
    refresh: "",
    access: "authenticated",
    expires: Date.now() + 3600000,
  }
}

// Named export for bundling: same function reference as the default's `server`,
// so the two can't drift. Lets opencode do `import { KiroAuthPlugin }`, matching
// GitlabAuthPlugin/PoeAuthPlugin/CopilotAuthPlugin.
export const KiroAuthPlugin: Plugin = server

// Default export drives opencode's external plugin loader, which reads `default`.
export default { id: "kiro", server }
