import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// V1 server plugin module (opencode shared.ts readV1Plugin). This module must
// NEVER export a `tui` key — the loader rejects modules exporting both kinds.
//
// AUTH-ONLY: the Kiro provider/model catalog is published to models.dev
// (provider id `kiro`, `npm: "kiro-acp-ai-provider"`), so opencode loads the
// full model list from the catalog. This plugin therefore only supplies the
// `auth` hook (kiro-cli login flow + a `loader` that returns the provider
// OPTIONS resolveSDK forwards into `createKiroAcp({...})`). No `config`
// seeding and no `provider.models` hook — both would be redundant with the
// catalog and a maintenance burden.
const server = async (input: PluginInput): Promise<Hooks> => ({
  auth: {
    provider: "kiro",
    // Returned options become the provider options resolveSDK passes to the
    // SDK factory: createKiroAcp({ name, cwd, agent, trustAllTools,
    // mcpTimeout, contextWindows, ... }). Mirrors the old core custom loader.
    //
    // `provider` is opencode's resolved catalog entry (typed `Provider` from
    // `@opencode-ai/sdk` via AuthHook.loader). We relay each model's
    // `limit.context` (sourced from models.dev) into the SDK's
    // `contextWindows` map keyed by the model's `api.id`, so the SDK no longer
    // needs a built-in per-model table. Models with no/zero context limit are
    // skipped (the SDK falls back to 1M for any id absent from the map).
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

          // Already authenticated — return immediately
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

          // Not authenticated — launch kiro-cli auth login and poll
          const { execFile } = await import("node:child_process")
          const child = execFile("kiro-cli", ["login"])

          return {
            url: "",
            instructions:
              "Complete Kiro authentication in the browser window that just opened. Waiting for login...",
            method: "auto" as const,
            async callback() {
              // Poll until authenticated (kiro-cli auth login runs in background)
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

export default { id: "kiro", server }
