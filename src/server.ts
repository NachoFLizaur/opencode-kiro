import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { seedProviderConfig } from "./server/seed"

export { buildKiroModels, type KiroModelConfigMap } from "./server/models"
export { seedProviderConfig } from "./server/seed"

// V1 server plugin module (opencode shared.ts readV1Plugin). This module must
// NEVER export a `tui` key — the loader rejects modules exporting both kinds.
//
// Hooks:
// - `config`: idempotent seeding of `cfg.provider.kiro` (12 static models).
// - `auth`: kiro-cli login flow, ported verbatim from opencode
//   `packages/opencode/src/plugin/kiro-acp.ts`, plus a `loader` that supplies
//   the provider OPTIONS forwarded by resolveSDK into `createKiroAcp({...})`.
//
// Deliberately NO `provider.models` hook: that hook's gate
// (provider.ts `if (!provider) continue`) runs BEFORE config-seeded providers
// extend the provider DB, so it would no-op for this provider. The config
// seed therefore carries the FULL model list.
const server = async (input: PluginInput): Promise<Hooks> => ({
  config: async (cfg) => {
    seedProviderConfig(cfg)
  },
  auth: {
    provider: "kiro",
    // Returned options become the provider options resolveSDK passes to the
    // SDK factory: createKiroAcp({ name, cwd, agent, trustAllTools,
    // mcpTimeout, apiKey, ... }). Mirrors the old core custom loader.
    loader: async (_getAuth, _provider) => ({
      cwd: input.directory ?? input.worktree,
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
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
