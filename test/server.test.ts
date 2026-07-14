import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AuthHook, Config, PluginInput, ProviderHook } from "@opencode-ai/plugin"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { reasoningEffortsFor, verifyAuth } from "kiro-acp-ai-provider"
import type { KiroEffortLevel } from "kiro-acp-ai-provider"
import serverPlugin, { enableSidebarConfig, notifyIfTokenExpired, readToken } from "../src/server"

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

// authorize()'s not-authed branch spawns `kiro-cli login`; stub child_process so
// the consent-write tests exercise the poll branch without launching a real binary.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => ({ kill: vi.fn() })),
}))

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

// Isolate XDG_CONFIG_HOME (tui.json) and XDG_DATA_HOME (auth.json) for the whole
// file so neither the consent writer nor the config-hook credential probe ever
// touches the developer's real ~/.config or ~/.local/share. The data dir starts
// EMPTY, so hasStoredKiroCredential() defaults to false everywhere; the config
// suite writes its own auth.json per case.
let xdgDir: string
let prevXdg: string | undefined
let xdgDataDir: string
let prevXdgData: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_CONFIG_HOME
  xdgDir = mkdtempSync(join(tmpdir(), "kiro-tui-test-"))
  process.env.XDG_CONFIG_HOME = xdgDir
  prevXdgData = process.env.XDG_DATA_HOME
  xdgDataDir = mkdtempSync(join(tmpdir(), "kiro-data-test-"))
  process.env.XDG_DATA_HOME = xdgDataDir
})
afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = prevXdg
  rmSync(xdgDir, { recursive: true, force: true })
  if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdgData
  rmSync(xdgDataDir, { recursive: true, force: true })
})

const tuiJsonPath = () => join(xdgDir, "opencode", "tui.json")

/**
 * Fake PluginInput. The server module reads directory/worktree; the auth loader
 * fires the (fire-and-forget) login nudge via input.client.tui.showToast, so we
 * stub showToast here. server() startup itself touches none of this.
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

    // Surfaces exactly the auth, config, and provider hooks (no tool/event/etc).
    expect(Object.keys(hooks).sort()).toEqual(["auth", "config", "provider"])
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

  test("auth loader tolerates empty/undefined models and malformed entries (no throw)", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    // An undefined provider and an empty models map both yield no windows.
    await expect(
      hooks.auth?.loader?.(neverAuth, undefined as unknown as Parameters<LoaderFn>[1]),
    ).resolves.toMatchObject({ contextWindows: {} })
    await expect(
      hooks.auth?.loader?.(neverAuth, { models: {} } as unknown as Parameters<LoaderFn>[1]),
    ).resolves.toMatchObject({ contextWindows: {} })

    // A malformed entry (no api.id) is filtered out; the well-formed one survives.
    const mixed = {
      models: {
        good: { api: { id: "good" }, limit: { context: 123 } },
        "no-api": { limit: { context: 999 } },
      },
    } as unknown as Parameters<LoaderFn>[1]
    const options = await hooks.auth?.loader?.(neverAuth, mixed)
    expect((options as { contextWindows: Record<string, number> }).contextWindows).toEqual({
      good: 123,
    })
  })
})

// The config hook supplies a minimal usable provider while the models.dev Kiro entry is
// unavailable. It is gated on a stored Kiro credential, so non-Kiro users get no startup
// work or phantom provider. OpenCode merges this overlay with the full catalog when present.
describe("config hook (kiro auto fallback, gated on a stored kiro credential)", () => {
  const authJsonPath = () => join(xdgDataDir, "opencode", "auth.json")
  const writeAuthJson = (body: unknown): void => {
    mkdirSync(dirname(authJsonPath()), { recursive: true })
    writeFileSync(authJsonPath(), JSON.stringify(body))
  }
  afterEach(() => rmSync(join(xdgDataDir, "opencode"), { recursive: true, force: true }))

  const expectedFallback = {
    name: "Kiro",
    env: ["KIRO_API_KEY"],
    npm: "kiro-acp-ai-provider",
    api: "https://q.us-east-1.amazonaws.com",
    models: {
      auto: {
        name: "Auto",
        family: "claude-sonnet",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 1_000_000, output: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  }

  /** Run the config hook against the given config, mutating it in place. */
  const runConfig = async (input: Config): Promise<void> => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))
    await hooks.config?.(input)
  }

  test("no stored credential (no auth.json): hook is a no-op, adds no provider.kiro", async () => {
    const input: Config = {}

    await runConfig(input)

    expect(input.provider).toBeUndefined()
  })

  test("auth.json without a kiro key: hook is a no-op, adds no provider.kiro", async () => {
    writeAuthJson({ github: { type: "oauth" }, anthropic: { type: "api" } })
    const input: Config = {}

    await runConfig(input)

    expect(input.provider).toBeUndefined()
  })

  test("stored kiro credential: creates a usable auto fallback", async () => {
    writeAuthJson({ kiro: { type: "oauth" } })
    const input: Config = {}

    await runConfig(input)

    expect(input.provider).toEqual({ kiro: expectedFallback })
  })

  test("stored kiro credential: reads opencode's default data path when XDG_DATA_HOME is unset", async () => {
    const prevHome = process.env.HOME
    const prevXdgData = process.env.XDG_DATA_HOME
    const home = mkdtempSync(join(tmpdir(), "kiro-home-test-"))

    try {
      delete process.env.XDG_DATA_HOME
      process.env.HOME = home
      const path = join(home, ".local", "share", "opencode", "auth.json")
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ kiro: { type: "oauth" } }))

      const input: Config = {}
      await runConfig(input)

      expect(input.provider).toEqual({ kiro: expectedFallback })
    } finally {
      if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdgData
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("stored kiro credential: adds the fallback without touching other providers", async () => {
    writeAuthJson({ kiro: { type: "oauth" } })
    const input: Config = { provider: { openai: { name: "OpenAI" } } }

    await runConfig(input)

    expect(input.provider?.kiro).toEqual(expectedFallback)
    expect(input.provider?.openai).toEqual({ name: "OpenAI" })
  })

  test("stored kiro credential: does NOT clobber an existing kiro entry", async () => {
    writeAuthJson({ kiro: { type: "oauth" } })
    const existing = { name: "Kiro", models: { foo: { name: "Foo" } } }
    const input: Config = { provider: { kiro: existing } }

    await runConfig(input)

    expect(input.provider?.kiro).toBe(existing)
    expect(input.provider?.kiro).toEqual({ name: "Kiro", models: { foo: { name: "Foo" } } })
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

  /** A present kiro credential for the hook's ctx.auth (shape irrelevant; only presence is gated). */
  const authedCtx = { auth: { type: "oauth" } } as unknown as Parameters<ModelsFn>[1]

  /** Run the provider.models hook against a fresh fake catalog of the given ids (authed by default). */
  const runModels = async (...ids: string[]) => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))
    return hooks.provider?.models?.(modelsProvider(...ids), authedCtx)
  }

  test("UNAUTHED (ctx.auth undefined): returns provider.models unchanged, never loads the SDK or adds variants", async () => {
    // The early return precedes the SDK import: an unauthed user gets the catalog
    // back untouched (no variants), proving reasoningEffortsFor is never reached.
    // claude-opus-4.8 would otherwise get a full variant ladder.
    mockReasoningEffortsFor.mockReturnValue(["low", "medium", "high", "xhigh", "max"])
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))
    const provider = modelsProvider("claude-opus-4.8", "claude-sonnet-4.5")

    // No auth in ctx: the gate returns the same models object, variant-free.
    const models = await hooks.provider?.models?.(provider, {})

    expect(models).toBe(provider.models)
    expect(models?.["claude-opus-4.8"]?.variants).toBeUndefined()
    expect(models?.["claude-sonnet-4.5"]?.variants).toBeUndefined()
    expect("variants" in (models?.["claude-opus-4.8"] ?? {})).toBe(false)
    // The SDK's effort lookup is never consulted pre-auth (gate precedes the import).
    expect(mockReasoningEffortsFor).not.toHaveBeenCalled()
  })

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

describe("sidebar consent prompt (static, no startup tui.json read)", () => {
  // Consent moved into the login flow: the prompt is a STATIC array and server()
  // no longer probes tui.json at startup. Each case still cleans the isolated
  // tui.json to prove startup behavior is independent of its content.
  afterEach(() => rmSync(join(xdgDir, "opencode"), { recursive: true, force: true }))

  const sidebarPrompt = (hook: AuthHook | undefined) =>
    hook?.methods[0]?.prompts?.find((p) => p.key === "sidebar")

  test("always exposes the static sidebar consent select", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    expect(hooks.auth?.methods[0]?.prompts).toHaveLength(1)
    const prompt = sidebarPrompt(hooks.auth)
    expect(prompt?.type).toBe("select")
    expect(prompt?.message).toBe("Enable the Kiro credits sidebar?")
    expect(prompt && "options" in prompt ? prompt.options.map((o) => o.value) : []).toEqual([
      "yes",
      "no",
    ])
  })

  test("performs no startup tui.json read: SAME static prompt even when tui.json lists opencode-kiro", async () => {
    // Precise regression guard for "no startup tui.json read". The OLD code read
    // tui.json at startup and, when opencode-kiro was already in `plugin`,
    // suppressed the prompt (empty array, "don't ask twice"). With THIS exact
    // input, an invariant single-item prompt proves startup no longer reads or
    // gates on tui.json; the prompt is now fully static.
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(tuiJsonPath(), JSON.stringify({ theme: "kanagawa", plugin: ["opencode-kiro"] }))

    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))

    expect(hooks.auth?.methods[0]?.prompts).toHaveLength(1)
    expect(sidebarPrompt(hooks.auth)?.message).toBe("Enable the Kiro credits sidebar?")
  })
})

describe("enableSidebarConfig writer (tui.json)", () => {
  // Each case drives the isolated tui.json the writer reads/writes.
  afterEach(() => rmSync(join(xdgDir, "opencode"), { recursive: true, force: true }))

  const readTui = (): Record<string, unknown> =>
    JSON.parse(readFileSync(tuiJsonPath(), "utf8")) as Record<string, unknown>

  test("adds opencode-kiro to plugin and writes NO plugin_enabled disable", async () => {
    // No file yet: the writer creates one carrying just the plugin entry.
    await enableSidebarConfig(tuiJsonPath(), makeInput({ directory: "/tmp/proj" }))

    const config = readTui()
    expect(config.plugin).toEqual(["opencode-kiro"])
    // The append model never disables the builtin context box.
    expect("plugin_enabled" in config).toBe(false)
  })

  test("appends opencode-kiro to an existing plugin array and preserves other keys", async () => {
    // Not configured yet (opencode-kiro absent): the writer adds it without
    // dropping the existing plugin or unrelated keys, and writes no disable.
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(tuiJsonPath(), JSON.stringify({ theme: "kanagawa", plugin: ["other-plugin"] }))

    await enableSidebarConfig(tuiJsonPath(), makeInput({ directory: "/tmp/proj" }))

    const config = readTui()
    expect(config.plugin).toEqual(["other-plugin", "opencode-kiro"])
    expect(config.theme).toBe("kanagawa")
    expect("plugin_enabled" in config).toBe(false)
  })

  test("is idempotent: an already-configured file is left untouched (no duplicate plugin)", async () => {
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(tuiJsonPath(), JSON.stringify({ plugin: ["opencode-kiro"] }))

    await enableSidebarConfig(tuiJsonPath(), makeInput({ directory: "/tmp/proj" }))

    const config = readTui()
    expect(config.plugin).toEqual(["opencode-kiro"])
    expect("plugin_enabled" in config).toBe(false)
  })

  test("leaves an existing unrelated plugin_enabled exactly as-is", async () => {
    // The plugin no longer manages plugin_enabled: a pre-existing entry (set by
    // the user for unrelated reasons) is preserved untouched while opencode-kiro
    // is added to `plugin`.
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(
      tuiJsonPath(),
      JSON.stringify({
        plugin: ["other-plugin"],
        plugin_enabled: { "internal:other": true },
      }),
    )

    await enableSidebarConfig(tuiJsonPath(), makeInput({ directory: "/tmp/proj" }))

    const config = readTui()
    expect(config.plugin).toEqual(["other-plugin", "opencode-kiro"])
    // The unrelated toggle is left exactly as written; nothing is deleted.
    expect(config.plugin_enabled).toEqual({ "internal:other": true })
  })

  test("does not clobber an existing but unparseable tui.json", async () => {
    mkdirSync(dirname(tuiJsonPath()), { recursive: true })
    writeFileSync(tuiJsonPath(), "{ not valid json")

    await enableSidebarConfig(tuiJsonPath(), makeInput({ directory: "/tmp/proj" }))

    // A parse failure must never overwrite the user's file.
    expect(readFileSync(tuiJsonPath(), "utf8")).toBe("{ not valid json")
  })
})

// Regression: the bug was that tui.json often was NOT written on the FIRST
// /connect. The sidebar write used to live in onSuccess(), reached only after a
// successful login; on a first connect the not-authed poll branch could time out
// before writing. The fix moves the write to fire on CONSENT, the instant
// authorize() runs, independent of the auth branch and the 120s poll.
describe("authorize sidebar consent write (decoupled from auth success)", () => {
  afterEach(() => rmSync(join(xdgDir, "opencode"), { recursive: true, force: true }))

  const authorizeWith = async (inputs: Record<string, string>) => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj" }))
    return hooks.auth?.methods[0]?.authorize?.(inputs)
  }

  test("writes tui.json on consent=yes even when NOT authenticated (poll branch, login not done)", async () => {
    // First-connect condition: installed but NOT logged in, so authorize takes
    // the login+poll branch. The write must already be on disk regardless of the
    // poll, proving it no longer depends on a successful login.
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })

    await authorizeWith({ sidebar: "yes" })

    const config = JSON.parse(readFileSync(tuiJsonPath(), "utf8")) as Record<string, unknown>
    expect(config.plugin).toEqual(["opencode-kiro"])
  })

  test("does NOT write tui.json when consent is not yes (no opt-in, not authenticated)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })

    await authorizeWith({ sidebar: "no" })

    expect(existsSync(tuiJsonPath())).toBe(false)
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

  // The nudge moved OUT of server() startup and INTO the auth loader, which core
  // only calls for users WITH a stored kiro credential. server() startup must
  // therefore be fully silent: it must not consult whoami (verifyAuth) or log,
  // even when the user is logged out. This is the core "no side effects for a
  // non-kiro user at startup" guarantee.
  test("server() startup runs no login nudge (no whoami, no warn)", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client } = makeToastClient()

    await serverPlugin.server({ directory: "/tmp/proj", client } as unknown as PluginInput)

    expect(mockVerifyAuth).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  // The nudge now lives in the auth loader as fire-and-forget. Invoking the
  // loader triggers it WITHOUT awaiting: even a never-settling toast (the F1
  // headless-hang condition) cannot block the loader's return, yet the warn line
  // still surfaces. Guards against re-introducing an awaited UI call on the auth
  // path and proves the nudge is wired into the loader.
  test("F1: auth loader fires the nudge fire-and-forget and returns promptly despite a dead toast", async () => {
    mockVerifyAuth.mockReturnValue({ installed: true, authenticated: false })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const showToast = vi.fn(() => new Promise<never>(() => {}))
    const input = {
      directory: "/tmp/proj",
      client: { tui: { showToast } },
    } as unknown as PluginInput

    const hooks = await serverPlugin.server(input)

    const start = Date.now()
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000))
    const outcome = await Promise.race([
      hooks.auth?.loader?.(neverAuth, fakeProvider).then(() => "resolved" as const),
      timeout,
    ])

    expect(outcome).toBe("resolved")
    expect(Date.now() - start).toBeLessThan(1000)

    // Let the fire-and-forget nudge settle, then assert it actually ran.
    await new Promise((r) => setTimeout(r, 50))
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain("kiro-cli login")
  })
})
