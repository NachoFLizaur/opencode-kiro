import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AuthHook, PluginInput, ProviderHook } from "@opencode-ai/plugin"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { reasoningEffortsFor, verifyAuth } from "kiro-acp-ai-provider"
import type { KiroEffortLevel } from "kiro-acp-ai-provider"
import serverPlugin, { notifyIfTokenExpired, readToken } from "../src/server"

// Auth hook contract tests. The authorize() browser/poll flow isn't unit-tested
// (it spawns kiro-cli); we assert only the method shape and the loader return.

// The auth gate is kiro-cli whoami via the SDK's verifyAuth(); mock it so unit
// tests drive logged-in / logged-out states without spawning kiro-cli or needing
// the SDK build. readToken/notifyIfTokenExpired consume the boolean only.
// reasoningEffortsFor is mocked too so the provider.models hook gets deterministic levels.
vi.mock("kiro-acp-ai-provider", () => ({
  verifyAuth: vi.fn(() => ({ installed: true, authenticated: true })),
  reasoningEffortsFor: vi.fn(() => []),
}))
const mockVerifyAuth = vi.mocked(verifyAuth)
const mockReasoningEffortsFor = vi.mocked(reasoningEffortsFor)

// Default to logged-in for every test (the common case: kiro-cli auto-re-auths);
// individual tests override to authenticated:false to exercise the failed/nudge
// paths. Reset each test so a prior implementation/return value never leaks.
beforeEach(() => {
  mockVerifyAuth.mockReset()
  mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
  // Default to no-effort (empty levels); the provider-hook tests override per model.
  mockReasoningEffortsFor.mockReset()
  mockReasoningEffortsFor.mockReturnValue([])
})

// Isolate XDG_CONFIG_HOME for the whole file so server()'s tui.json probe never
// reads (or the consent tests never write) the developer's real ~/.config.
let xdgDir: string
let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME
  xdgDir = mkdtempSync(join(tmpdir(), "kiro-tui-test-"))
  process.env.XDG_CONFIG_HOME = xdgDir
})
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
  rmSync(xdgDir, { recursive: true, force: true })
})

const tuiJsonPath = () => join(xdgDir, "opencode", "tui.json")

/**
 * Fake PluginInput. The server module reads directory/worktree and, at startup,
 * calls input.client.tui.showToast for the expiry nudge; stub it so server()
 * exercises the toast path (not the console.warn fallback) during these tests.
 */
const makeInput = (input: { directory?: string; worktree?: string }): PluginInput =>
  ({ ...input, client: { tui: { showToast: async () => true } } }) as unknown as PluginInput

type LoaderFn = NonNullable<AuthHook["loader"]>

/** The loader must ignore its getAuth arg. */
const neverAuth: Parameters<LoaderFn>[0] = async () => {
  throw new Error("loader must not call getAuth")
}

/** Fake catalog provider; includes zero-limit and missing-limit models to prove they're filtered from the relay. */
const fakeProvider = {
  models: {
    "claude-sonnet-4.5": { api: { id: "claude-sonnet-4.5" }, limit: { context: 200_000 } },
    "claude-opus-4.6": { api: { id: "claude-opus-4.6" }, limit: { context: 1_000_000 } },
    "deepseek-3.2": { api: { id: "deepseek-3.2" }, limit: { context: 164_000 } },
    "zero-limit": { api: { id: "zero-limit" }, limit: { context: 0 } },
    "missing-limit": { api: { id: "missing-limit" } },
  },
} as unknown as Parameters<LoaderFn>[1]

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Import a built module via a runtime URL so tsc never resolves dist/. */
const importDist = (name: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(ROOT, "dist", name)).href) as Promise<Record<string, unknown>>

describe("server hooks", () => {
  test("auth hook contract", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj", worktree: "/tmp/wt" }))

    // Surfaces exactly the auth + provider hooks (no config/tool/etc).
    expect(Object.keys(hooks).sort()).toEqual(["auth", "provider"])
    expect(hooks.auth?.provider).toBe("kiro")
    expect(hooks.auth?.methods).toHaveLength(1)
    const method = hooks.auth?.methods[0]
    expect(method?.type).toBe("oauth")
    expect(method?.label).toBe("Kiro CLI Login")
    // Flow internals (browser/poll/kiro-cli) are live coverage.
    expect(typeof method?.authorize).toBe("function")
  })

  test("auth loader returns core-parity options + relays catalog context windows", async () => {
    // These become the options forwarded into createKiroAcp({...}).
    const hooks = await serverPlugin.server(
      makeInput({ directory: "/tmp/proj", worktree: "/tmp/elsewhere" }),
    )

    const options = await hooks.auth?.loader?.(neverAuth, fakeProvider)

    // Four core options (directory wins over worktree) plus the relayed
    // contextWindows keyed by api.id (zero/missing-limit filtered out).
    expect(options).toEqual({
      cwd: "/tmp/proj",
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
      contextWindows: {
        "claude-sonnet-4.5": 200_000,
        "claude-opus-4.6": 1_000_000,
        "deepseek-3.2": 164_000,
      },
    })
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "agent",
      "contextWindows",
      "cwd",
      "mcpTimeout",
      "trustAllTools",
    ])
    // Zero-limit and missing-limit models never reach the relay map.
    const windows = (options as { contextWindows: Record<string, number> }).contextWindows
    expect("zero-limit" in windows).toBe(false)
    expect("missing-limit" in windows).toBe(false)
  })

  test("auth loader falls back to worktree", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: undefined, worktree: "/tmp/wt" }))

    const options = await hooks.auth?.loader?.(neverAuth, fakeProvider)

    expect(options?.cwd).toBe("/tmp/wt")
  })
})

// The provider.models hook injects per-model reasoning-effort variants (cycle thinking effort).
describe("provider hook (reasoning effort variants)", () => {
  type ModelsFn = NonNullable<ProviderHook["models"]>

  /** Minimal catalog provider for the models() hook: it only reads api.id. */
  const modelsProvider = (...ids: string[]): Parameters<ModelsFn>[0] =>
    ({
      models: Object.fromEntries(ids.map((id) => [id, { api: { id } }])),
    }) as unknown as Parameters<ModelsFn>[0]

  /** Run the provider.models hook against a fresh fake catalog of the given ids. */
  const runModels = async (...ids: string[]) => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))
    return hooks.provider?.models?.(modelsProvider(...ids), {})
  }

  test("builds variants for an effort-capable model keyed by its native levels", async () => {
    // claude-opus-4.8 exposes the full native effort ladder.
    const levels: KiroEffortLevel[] = ["low", "medium", "high", "xhigh", "max"]
    mockReasoningEffortsFor.mockReturnValue(levels)

    const models = await runModels("claude-opus-4.8")

    expect(models?.["claude-opus-4.8"]?.variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    })
  })

  test("uses the model's reduced native set (no xhigh) verbatim, with no remap", async () => {
    // claude-opus-4.6 supports every native level except xhigh.
    const levels: KiroEffortLevel[] = ["low", "medium", "high", "max"]
    mockReasoningEffortsFor.mockReturnValue(levels)

    const models = await runModels("claude-opus-4.6")
    const variants = models?.["claude-opus-4.6"]?.variants

    expect(Object.keys(variants ?? {})).toEqual(levels)
    expect("xhigh" in (variants ?? {})).toBe(false)
    expect(variants?.high).toEqual({ reasoningEffort: "high" })
  })

  test("leaves a non-effort model without a variants key", async () => {
    // claude-sonnet-4.5 has no effort control: reasoningEffortsFor returns [].
    mockReasoningEffortsFor.mockReturnValue([])

    const models = await runModels("claude-sonnet-4.5")
    const model = models?.["claude-sonnet-4.5"]

    expect(model?.variants).toBeUndefined()
    expect("variants" in (model ?? {})).toBe(false)
  })

  test("exposes a provider hook with id kiro alongside the unchanged auth hook", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    // The provider hook is additive: it coexists with the (unchanged) auth hook.
    expect(hooks.provider?.id).toBe("kiro")
    expect(typeof hooks.provider?.models).toBe("function")
    expect(hooks.auth?.provider).toBe("kiro")
  })
})

describe("sidebar consent prompt (tui.json probe)", () => {
  // Each case controls the isolated tui.json that server() probes at startup.
  afterEach(() => rmSync(join(xdgDir, "opencode"), { recursive: true, force: true }))

  const sidebarPrompt = (hook: AuthHook | undefined) =>
    hook?.methods[0]?.prompts?.find((p) => p.key === "sidebar")

  test("offers the sidebar select when tui.json is not configured", async () => {
    // No tui.json present -> not configured -> the consent prompt is shown.
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    const prompt = sidebarPrompt(hooks.auth)
    expect(prompt?.type).toBe("select")
    expect(prompt?.message).toBe("Enable the Kiro credits sidebar?")
    expect(prompt && "options" in prompt ? prompt.options.map((o) => o.value) : []).toEqual([
      "yes",
      "no",
    ])
  })

  test("omits the prompt when tui.json already has the sidebar configured", async () => {
    // Seed an already-configured tui.json: opencode-kiro in `plugin` AND the
    // builtin sidebar disabled -> "don't ask twice" -> empty prompts.
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(
      tuiJsonPath(),
      JSON.stringify({
        theme: "kanagawa",
        plugin: ["opencode-kiro"],
        plugin_enabled: { "internal:sidebar-context": false },
      }),
    )

    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    expect(hooks.auth?.methods[0]?.prompts).toEqual([])
    expect(sidebarPrompt(hooks.auth)).toBeUndefined()
  })

  test("still offers the prompt when only partially configured", async () => {
    // Plugin listed but builtin sidebar NOT disabled -> not fully configured.
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(tuiJsonPath(), JSON.stringify({ plugin: ["opencode-kiro"] }))

    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    expect(sidebarPrompt(hooks.auth)?.type).toBe("select")
  })
})

describe("dist/server.js module isolation", () => {
  test("server module exports no tui", async () => {
    // Namespace-level isolation (scaffold.test.ts already covers the DEFAULT
    // export shape): no `tui` anywhere in the module namespace.
    const mod = await importDist("server.js")

    expect("tui" in mod).toBe(false)
  })

  test("named KiroAuthPlugin is the same function as the default server", async () => {
    // Bundling export: must be a function and the SAME reference as the
    // default's `server`, so the two can't drift.
    const mod = await importDist("server.js")
    const def = mod.default as { server: unknown }

    expect(typeof mod.KiroAuthPlugin).toBe("function")
    expect(mod.KiroAuthPlugin).toBe(def.server)
  })
})

// Token-file helpers shared by the readToken + startup-nudge suites. Each writes
// an isolated temp kiro-auth-token.json so tests never touch the real
// ~/.aws/sso/cache file (and never spawn kiro-cli).
const tokenDirs: string[] = []
afterEach(() => {
  while (tokenDirs.length) rmSync(tokenDirs.pop() as string, { recursive: true, force: true })
})

/** Write a token file (JSON body or raw string) and return its path. */
const writeTokenFile = (content: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-token-"))
  tokenDirs.push(dir)
  const path = join(dir, "kiro-auth-token.json")
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
  return path
}

/** ISO timestamp offset from now (positive = future, negative = past). */
const isoFromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

/** A missing path that definitely does not exist. */
const missingTokenPath = (): string => join(tmpdir(), "kiro-missing-does-not-exist-xyz.json")

describe("readToken (whoami-gated)", () => {
  // THE CORE BUG (0.1.2 regression we are fixing): a logged-in user whose cached
  // on-disk token file is STALE (expiresAt in the PAST) was wrongly refused. Now
  // whoami (verifyAuth().authenticated) is the gate, so the stale file still
  // yields success, a FUTURE expires, and the file's REAL refresh token.
  test("logged-in user with a STALE file still returns success (core regression)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
    const before = Date.now()
    const path = writeTokenFile({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: isoFromNow(-3_600_000), // 1h in the PAST: stale on disk
    })

    const result = await readToken(path)

    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error("expected success")
    // Carries the file's REAL refresh token despite the past file expiry.
    expect(result.refresh).toBe("refresh-xyz")
    expect(result.access).toBe("access-abc")
    // expires is a FUTURE value (Date.now()+8h), NOT the file's past expiresAt.
    expect(result.expires).toBeGreaterThan(before)
    expect(result.expires).toBeGreaterThan(Date.now())
  })

  test("logged-in user with a future-expiry file carries its real refresh", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
    const path = writeTokenFile({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: isoFromNow(3_600_000),
    })

    const result = await readToken(path)

    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error("expected success")
    expect(result.refresh).toBe("refresh-xyz")
    expect(result.access).toBe("access-abc")
    expect(result.expires).toBeGreaterThan(Date.now())
  })

  test("logged-in user with NO token file still returns success (file is optional)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })

    const result = await readToken(undefined)

    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error("expected success")
    expect(result.refresh).toBe("")
    expect(result.access).toBe("authenticated")
    expect(result.expires).toBeGreaterThan(Date.now())
  })

  test("logged-in user with a missing file path still returns success", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })

    const result = await readToken(missingTokenPath())

    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error("expected success")
    expect(result.refresh).toBe("")
    expect(result.access).toBe("authenticated")
  })

  test("logged-in user with an invalid-JSON file still returns success (file ignored)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
    const path = writeTokenFile("{ not valid json")

    const result = await readToken(path)

    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error("expected success")
    expect(result.refresh).toBe("")
    expect(result.access).toBe("authenticated")
  })

  test("NOT logged in returns failed even with a valid file present (no record)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const path = writeTokenFile({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAt: isoFromNow(3_600_000),
    })

    expect(await readToken(path)).toEqual({ type: "failed" })
  })

  test("NOT logged in with no token file returns failed", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })

    expect(await readToken(undefined)).toEqual({ type: "failed" })
  })
})

describe("startup login nudge (notifyIfTokenExpired)", () => {
  afterEach(() => vi.restoreAllMocks())

  /** Fake client whose showToast records its calls. */
  const makeToastClient = () => {
    const showToast = vi.fn(
      async (_opts: { body: { message: string; variant: string } }) => true,
    )
    const client = { tui: { showToast } } as unknown as PluginInput["client"]
    return { client, showToast }
  }

  /** Fake client whose showToast always rejects. */
  const makeThrowingClient = () =>
    ({
      tui: {
        showToast: async () => {
          throw new Error("toast boom")
        },
      },
    }) as unknown as PluginInput["client"]

  test("is SILENT for a logged-in user (no false-fire on every startup)", async () => {
    // whoami reports logged in (the common case: kiro-cli auto-re-auths).
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: true })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, showToast } = makeToastClient()

    await notifyIfTokenExpired(client)

    expect(showToast).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test("fires a warning toast naming kiro-cli login when NOT logged in", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, showToast } = makeToastClient()

    await notifyIfTokenExpired(client)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledTimes(1)
    const arg = showToast.mock.calls[0][0]
    expect(arg.body.variant).toBe("warning")
    expect(arg.body.message).toContain("kiro-cli login")
  })

  test("logs the fallback nudge when not logged in and no client/TUI is available", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(notifyIfTokenExpired(undefined)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("kiro-cli login")
  })

  test("never throws when verifyAuth itself throws (gate fails closed, no nudge)", async () => {
    mockVerifyAuth.mockImplementation(() => {
      throw new Error("whoami boom")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(notifyIfTokenExpired(makeThrowingClient())).resolves.toBeUndefined()
    // The gate threw before the log line; no nudge is emitted, but never throws.
    expect(warn).not.toHaveBeenCalled()
  })

  test("never throws when NOT logged in AND showToast throws (log-first still fires)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(notifyIfTokenExpired(makeThrowingClient())).resolves.toBeUndefined()
    // Toast rejected -> the log line still surfaced first.
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // FINDING F1 regression: a HEADLESS (non-TUI) run has no toast receiver, so
  // showToast's promise NEVER settles. The old code AWAITED it, hanging startup
  // forever (it hangs rather than throws, so the try/catch + .catch() never ran).
  // This stub reproduces that exact condition; the fix logs FIRST and fires the
  // toast WITHOUT awaiting, so the call must still resolve promptly. The other
  // tests only mock showToast to RESOLVE or THROW, so they never caught the hang.
  test("F1: resolves promptly without awaiting a never-settling showToast (headless hang)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // The precise F1 trigger: a toast promise that NEVER settles.
    const showToast = vi.fn(() => new Promise<never>(() => {}))
    const client = { tui: { showToast } } as unknown as PluginInput["client"]

    // Race the call against a short timeout. If notifyIfTokenExpired AWAITED the
    // never-settling toast it would lose this race (and hang the suite); winning
    // it promptly proves the toast is fire-and-forget.
    const start = Date.now()
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000))
    const outcome = await Promise.race([
      notifyIfTokenExpired(client).then(() => "resolved" as const),
      timeout,
    ])

    expect(outcome).toBe("resolved")
    expect(Date.now() - start).toBeLessThan(1000)
    // Toast was still invoked (fire-and-forget), just never awaited.
    expect(showToast).toHaveBeenCalledTimes(1)
    // LOG FIRST: the nudge line surfaced synchronously despite the dead toast.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("kiro-cli login")
  })

  // F1, server(input) path: the startup nudge runs inside server(); proving the
  // whole startup hook returns promptly even when its toast never settles guards
  // against re-introducing an awaited UI call on the startup path.
  test("F1: server(input) startup returns promptly when showToast never settles", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const showToast = vi.fn(() => new Promise<never>(() => {}))
    const input = {
      directory: "/tmp/proj",
      client: { tui: { showToast } },
    } as unknown as PluginInput

    const start = Date.now()
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000))
    const outcome = await Promise.race([
      serverPlugin.server(input).then(() => "resolved" as const),
      timeout,
    ])

    expect(outcome).toBe("resolved")
    expect(Date.now() - start).toBeLessThan(1000)
  })
})
