import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// plugin name in tui.json's `plugin` array; we only ensure it's present, never touch `plugin_enabled`
const KIRO_PLUGIN_NAME = "opencode-kiro"

// auth-only server plugin; the catalog lives on models.dev. never export `tui` (loader rejects modules with both).
// runs for EVERY user at startup, so zero side effects for non-kiro users: no output, toast, kiro-cli spawn, or fs read.
// the login nudge is deferred into the auth loader (auth-gated) and sidebar consent runs only during login.
const server = async (input: PluginInput): Promise<Hooks> => {
  // consent prompt; only shown during the Kiro CLI Login flow, not at startup. enableSidebarConfig is idempotent so we always offer it.
  const prompts = [
    {
      type: "select" as const,
      key: "sidebar",
      message: "Enable the Kiro credits sidebar?",
      options: [
        { label: "Yes", value: "yes", hint: "writes tui.json; restart to apply" },
        { label: "No", value: "no" },
      ],
    },
  ]

  return {
    auth: {
      provider: "kiro",
      // options forwarded into createKiroAcp(). maps each model's limit.context into contextWindows by api.id; zero/missing skipped (SDK falls back to 1M).
      loader: async (_getAuth, provider) => {
        // nudge expired logins, fire-and-forget (don't await/block). loader only runs when a kiro cred exists, so this is auth-gated.
        void notifyIfTokenExpired(input.client)
        return {
          cwd: input.directory ?? input.worktree,
          agent: "opencode",
          trustAllTools: true,
          mcpTimeout: 45,
          contextWindows: Object.fromEntries(
            Object.values(provider?.models ?? {})
              .filter((m) => m.api?.id && (m.limit?.context ?? 0) > 0)
              .map((m) => [m.api.id, m.limit.context]),
          ),
        }
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Kiro CLI Login",
          prompts,
          async authorize(inputs) {
            const { verifyAuth } = await import("kiro-acp-ai-provider")
            const status = verifyAuth()

            if (!status.installed)
              throw new Error(
                "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/",
              )

            // consent, not auth success, is the trigger: wire the sidebar the instant the user opts in, before any auth branching or the 120s poll. enableSidebarConfig is idempotent.
            if (inputs?.sidebar === "yes") await enableSidebarConfig(tuiConfigPath(), input)

            // already authed: skip the login flow
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

            // not authed: launch kiro-cli login and poll
            const { execFile } = await import("node:child_process")
            // shell:true on win32 so bare "kiro-cli" resolves via PATHEXT to .exe/.cmd (matches the SDK's spawns); shell:false elsewhere
            const child = execFile("kiro-cli", ["login"], {
              shell: process.platform === "win32",
            })

            return {
              url: "",
              instructions:
                "Complete Kiro authentication in the browser window that just opened. Waiting for login...",
              method: "auto" as const,
              async callback() {
                // poll until authed (login runs in the background)
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
                  "Kiro authentication timed out. Run `kiro-cli login` manually.",
                )
              },
            }
          },
        },
      ],
    },
    // crash guard: core derefs an undefined kiro provider during auth init when a cred exists but the catalog lacks kiro.
    // only inject when authed; ??= is idempotent and won't clobber a real catalog entry.
    config: async (input) => {
      if (!hasStoredKiroCredential()) return
      input.provider ??= {}
      input.provider.kiro ??= {}
    },
    provider: {
      id: "kiro",
      // inject per-model reasoning-effort variants (consumed as providerOptions.kiro.reasoningEffort)
      async models(provider, ctx) {
        // auth-gate: don't load the SDK or inject variants until the user is authed with kiro
        if (!ctx.auth) return provider.models
        const { reasoningEffortsFor } = await import("kiro-acp-ai-provider")
        for (const model of Object.values(provider.models)) {
          // guard the api.id deref: a malformed catalog entry must not fail registration
          const apiId = model.api?.id
          if (!apiId) continue
          const levels = reasoningEffortsFor(apiId)
          if (levels.length === 0) continue // non-effort models: no variants
          model.variants = Object.fromEntries(
            levels.map((level) => [level, { reasoningEffort: level }]),
          )
        }
        return provider.models
      },
    },
  }
}

// kiro-cli token file the SDK reads (~/.aws/sso/cache/kiro-auth-token.json). kept in sync with the SDK's verifyAuth() so we inspect the same file.
export function kiroTokenPath(): string {
  return join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
}

// read+parse the token file; undefined when missing, unreadable, or non-object. never throws.
async function readKiroTokenFile(
  tokenPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const parsed = JSON.parse(await readFile(tokenPath, "utf8"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// build opencode's auth record, gated on kiro-cli whoami, NOT the on-disk file.
// file expiresAt is meaningless (kiro-cli never rewrites it; the cred lives in the OS store and whoami self-heals), so a stale/missing file must not refuse a logged-in user.
// on success emits a future expires so core doesn't flag the provider, and carries the file's real refresh token when present.
export async function readToken(
  tokenPath: string | undefined,
): Promise<
  | { type: "success"; refresh: string; access: string; expires: number }
  | { type: "failed" }
> {
  // authority is kiro-cli whoami (abstracts the per-OS credential store)
  const { verifyAuth } = await import("kiro-acp-ai-provider")
  if (!verifyAuth().authenticated) return { type: "failed" as const }

  // logged in. the cached file is optional, only for the real refresh token / cosmetic access; a stale/missing file must not refuse a logged-in user (the core bug). never throws.
  const token = tokenPath ? await readKiroTokenFile(tokenPath) : undefined
  const access = typeof token?.accessToken === "string" ? token.accessToken : ""
  const refresh = typeof token?.refreshToken === "string" ? token.refreshToken : ""

  return {
    type: "success" as const,
    refresh, // real refresh when present, else ""
    access: access || "authenticated", // cosmetic; opencode-core only needs presence
    // future expiry, refreshed each startup (server() re-runs per session) so core doesn't flag a logged-in user as expired. not the file value.
    expires: Date.now() + 8 * 60 * 60 * 1000,
  }
}

// nudge when kiro-cli whoami reports not-logged-in. gate is whoami, not the file expiresAt (meaningless, false-warns every startup).
// must never throw/reject/block: the loader runs in an Effect.promise, so a rejection crashes ALL providers and a hang blocks startup.
// F1: log FIRST (synchronous, reaches headless runs), then fire-and-forget the toast; headless has no TUI receiver, so awaiting showToast hangs forever.
export async function notifyIfTokenExpired(
  client: PluginInput["client"] | undefined,
): Promise<void> {
  try {
    const { verifyAuth } = await import("kiro-acp-ai-provider")
    if (verifyAuth().authenticated) return // logged in per whoami: no nudge

    const message = "Kiro is not logged in. Run 'kiro-cli login' to authenticate."

    // log first: synchronous, the only channel that reaches a headless run
    console.warn(message)

    // toast is fire-and-forget: with no TUI attached the promise never settles, so awaiting would hang (F1)
    void client?.tui?.showToast?.({ body: { message, variant: "warning" } })?.catch(() => {})
  } catch {
    // never rethrow: a rejection becomes a defect that crashes all providers
  }
}

// stored kiro cred? read auth.json from opencode's xdg-basedir data path.
// true iff a "kiro" key exists. silent and never throws: gates a hook that runs for every user.
function hasStoredKiroCredential(): boolean {
  return authJsonPaths().some((path) => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "kiro" in parsed
    } catch {
      return false
    }
  })
}

function authJsonPaths(): string[] {
  if (process.env.XDG_DATA_HOME) return [join(process.env.XDG_DATA_HOME, "opencode", "auth.json")]

  const current = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform !== "win32") return [current]

  return [current, join(homedir(), ".opencode", "auth.json")]
}

// global tui.json: $XDG_CONFIG_HOME, else ~/.config. mirrors opencode's resolution so the toggle lands where the TUI reads it.
function tuiConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "tui.json")
}

// "configured" = opencode-kiro is in the `plugin` array; that single entry is all the credits box needs. we never touch `plugin_enabled`.
function isSidebarConfigured(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false
  const plugin = config.plugin
  return Array.isArray(plugin) && plugin.includes(KIRO_PLUGIN_NAME)
}

// idempotently add opencode-kiro to tui.json's `plugin` array after login. append-only: never touches `plugin_enabled`.
// non-destructive: starts from {} when missing, bails on unparseable (no clobber), preserves other keys, never throws (a write failure must not fail auth). exported for tests.
export async function enableSidebarConfig(path: string, input: PluginInput): Promise<void> {
  try {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises")

    // read raw separately from parsing so "missing" (start from {}) differs from "exists but unparseable" (don't clobber)
    let raw: string | undefined
    try {
      raw = await readFile(path, "utf8")
    } catch {
      raw = undefined
    }

    let config: Record<string, unknown>
    if (raw === undefined) {
      config = {}
    } else {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
        config = parsed as Record<string, unknown>
      } catch {
        // exists but unparseable: skip the write, don't clobber
        return
      }
    }

    // idempotent: already wired up, nothing to do
    if (isSidebarConfigured(config)) return

    // add opencode-kiro to `plugin` (create + dedup), preserve any others
    const plugin = Array.isArray(config.plugin) ? [...(config.plugin as unknown[])] : []
    if (!plugin.includes(KIRO_PLUGIN_NAME)) plugin.push(KIRO_PLUGIN_NAME)
    config.plugin = plugin

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8")

    // best-effort notice: only renders with a TUI attached, harmless otherwise
    try {
      await input.client.tui.showToast({
        body: {
          message: "Kiro credits sidebar enabled. Restart opencode to see it.",
          variant: "success",
        },
      })
    } catch {
      // no TUI / toast unavailable: ignore
    }
  } catch (err) {
    // log but don't rethrow: a config-write error must not break a successful auth
    console.error("opencode-kiro: failed to enable the Kiro credits sidebar in tui.json:", err)
  }
}

// named export, same reference as the default's `server` so the two can't drift. matches GitlabAuthPlugin/PoeAuthPlugin/CopilotAuthPlugin.
export const KiroAuthPlugin: Plugin = server

// default export drives opencode's external plugin loader, which reads `default`
export default { id: "kiro", server }
