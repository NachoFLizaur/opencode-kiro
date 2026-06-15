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

/** The loader must ignore its args — calling getAuth would reject the test. */
const neverAuth: Parameters<LoaderFn>[0] = async () => {
  throw new Error("loader must not call getAuth")
}
const fakeProvider = {} as Parameters<LoaderFn>[1]

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

  test("auth loader returns core-parity options", async () => {
    // Parity with old core custom loader (provider.ts:996-1001): these become
    // the provider options resolveSDK forwards into createKiroAcp({...}).
    const hooks = await serverPlugin.server(
      makeInput({ directory: "/tmp/proj", worktree: "/tmp/elsewhere" }),
    )

    const options = await hooks.auth?.loader?.(neverAuth, fakeProvider)

    expect(options).toEqual({
      cwd: "/tmp/proj", // directory wins over worktree when both are set
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
    })
    expect(Object.keys(options ?? {}).sort()).toEqual(["agent", "cwd", "mcpTimeout", "trustAllTools"])
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
