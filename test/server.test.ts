import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AuthHook, PluginInput } from "@opencode-ai/plugin"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import serverPlugin from "../src/server"

// Auth hook contract tests. The authorize() browser/poll flow isn't unit-tested
// (it spawns kiro-cli); we assert only the method shape and the loader return.

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

/** Fake PluginInput; the server module only reads directory and worktree. */
const makeInput = (input: { directory?: string; worktree?: string }): PluginInput =>
  input as unknown as PluginInput

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

    // Auth-only: exactly `auth`, no config or provider hook.
    expect(Object.keys(hooks).sort()).toEqual(["auth"])
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
