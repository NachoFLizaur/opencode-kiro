import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AuthHook, PluginInput } from "@opencode-ai/plugin"
import { describe, expect, test } from "vitest"
import serverPlugin from "../src/server"

// Server module tests: the auth hook's synchronous contract. This plugin is
// AUTH-ONLY — the provider/model catalog comes from models.dev, so there is
// no `config` seeding and no `provider` hook to test here.
//
// The `authorize()` browser/poll flow is deliberately NOT unit-tested — it
// spawns kiro-cli and is covered live. Here we only assert the method SHAPE
// (type/label/authorize presence) and the `loader` return value. No opencode
// host, no kiro-cli, no network.

/**
 * Minimal fake PluginInput: plain object, no opencode runtime. The server
 * module only reads `directory` and `worktree`.
 */
const makeInput = (input: { directory?: string; worktree?: string }): PluginInput =>
  input as unknown as PluginInput

type LoaderFn = NonNullable<AuthHook["loader"]>

/** The loader must ignore its getAuth arg — calling it would reject the test. */
const neverAuth: Parameters<LoaderFn>[0] = async () => {
  throw new Error("loader must not call getAuth")
}

/**
 * Fake opencode catalog provider. The loader reads only `provider.models`,
 * relaying each model's `limit.context` (from models.dev) into the SDK's
 * `contextWindows` map keyed by `api.id`. Includes a zero-limit and a
 * missing-limit model to prove they are filtered out of the relay.
 */
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

/**
 * Import a built module via a runtime-computed file URL so `tsc --noEmit`
 * never tries to resolve `dist/` (gitignored, absent pre-build).
 */
const importDist = (name: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(ROOT, "dist", name)).href) as Promise<Record<string, unknown>>

describe("server hooks", () => {
  test("auth hook contract", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj", worktree: "/tmp/wt" }))

    // AUTH-ONLY: exactly `auth` — no `config` seeding (the catalog comes from
    // models.dev) and no `provider` hook.
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
    // Parity with old core custom loader (provider.ts:996-1001): these become
    // the provider options resolveSDK forwards into createKiroAcp({...}).
    const hooks = await serverPlugin.server(
      makeInput({ directory: "/tmp/proj", worktree: "/tmp/elsewhere" }),
    )

    const options = await hooks.auth?.loader?.(neverAuth, fakeProvider)

    // (a) the four core options, with directory winning over worktree, plus
    // (b) the relayed contextWindows map keyed by api.id — zero/missing-limit
    // models are filtered out.
    expect(options).toEqual({
      cwd: "/tmp/proj", // directory wins over worktree when both are set
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

describe("dist/server.js module isolation", () => {
  test("server module exports no tui", async () => {
    // Namespace-level isolation (scaffold.test.ts already covers the DEFAULT
    // export shape): no `tui` anywhere in the module namespace.
    const mod = await importDist("server.js")

    expect("tui" in mod).toBe(false)
  })
})
