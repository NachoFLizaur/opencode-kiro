import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AuthHook, Config, PluginInput } from "@opencode-ai/plugin"
import { KIRO_MODEL_DEFAULTS } from "kiro-acp-ai-provider"
import { describe, expect, test } from "vitest"
import serverPlugin, { buildKiroModels, seedProviderConfig } from "../src/server"

// Server module tests (task 09, for task 07): idempotent provider seeding,
// the 12-model config list, and the auth hook's synchronous contract.
//
// The `authorize()` browser/poll flow is deliberately NOT unit-tested — it
// spawns kiro-cli and is covered live in task 10. Here we only assert the
// method SHAPE (type/label/authorize presence) and the `loader` return value,
// per the task 09 spec. No opencode host, no kiro-cli, no network.

/** The exact 12 model ids seeded by task 07 (sorted), pinned as literals. */
const KIRO_MODEL_IDS = [
  "auto",
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "deepseek-3.2",
  "minimax-m2.1",
  "minimax-m2.5",
  "qwen3-coder-next",
]

/**
 * Minimal fake PluginInput (task 09 mocking spec: plain object, no opencode
 * runtime). The server module only reads `directory` and `worktree`.
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

describe("seedProviderConfig", () => {
  test("seeds kiro provider into empty config", () => {
    const cfg: Config = {}

    const result = seedProviderConfig(cfg)

    // Mutate-and-return contract: the SHARED host config object comes back.
    expect(result).toBe(cfg)
    const kiro = cfg.provider?.["kiro"]
    expect(kiro).toBeDefined()
    // Exact seeded entry shape — npm spec + display name + full model list.
    expect(Object.keys(kiro ?? {}).sort()).toEqual(["models", "name", "npm"])
    expect(kiro?.npm).toBe("kiro-acp-ai-provider")
    expect(kiro?.name).toBe("Kiro")
    expect(Object.keys(kiro?.models ?? {}).sort()).toEqual(KIRO_MODEL_IDS)
  })

  test("does not clobber existing provider.kiro", () => {
    // Any truthy pre-existing entry (user config, or a future models.dev-era
    // catalog entry) makes the seed step aside ENTIRELY — no merge, no models.
    const sentinel = { sentinel: true }
    const cfg = { provider: { kiro: sentinel } } as unknown as Config
    const before = structuredClone(cfg)

    const result = seedProviderConfig(cfg)

    expect(result).toBe(cfg)
    expect(cfg.provider?.["kiro"]).toBe(sentinel) // same reference, untouched
    expect(cfg).toEqual(before) // byte-identical — nothing injected anywhere
    expect((cfg.provider?.["kiro"] as Record<string, unknown>).models).toBeUndefined()
  })

  test("preserves sibling providers", () => {
    const openai = { npm: "@ai-sdk/openai", name: "OpenAI" }
    const cfg: Config = { provider: { openai } }

    seedProviderConfig(cfg)

    expect(cfg.provider?.["openai"]).toBe(openai) // same reference, untouched
    expect(cfg.provider?.["openai"]).toEqual({ npm: "@ai-sdk/openai", name: "OpenAI" })
    expect(cfg.provider?.["kiro"]?.npm).toBe("kiro-acp-ai-provider")
    expect(Object.keys(cfg.provider?.["kiro"]?.models ?? {})).toHaveLength(12)
  })
})

describe("buildKiroModels", () => {
  test("model list: 12 entries, tool_call, image input", () => {
    const models = buildKiroModels()

    expect(Object.keys(models)).toHaveLength(12)
    for (const [id, model] of Object.entries(models)) {
      // Exactly the six config fields task 07 maps — nothing extra, none missing.
      expect(Object.keys(model).sort()).toEqual([
        "limit",
        "modalities",
        "name",
        "reasoning",
        "temperature",
        "tool_call",
      ])
      expect(model.tool_call).toBe(true)
      expect(model.reasoning).toBe(false)
      expect(typeof model.name).toBe("string")
      expect(model.limit?.context).toBeGreaterThan(0)
      expect(model.limit?.output).toBe(64000)
      expect(model.modalities?.output).toEqual(["text"])
      // Image input everywhere EXCEPT minimax-m2.5 (SDK imageInput: false —
      // implementation actuals refine the generic "image in input" criterion).
      expect(model.modalities?.input).toEqual(id === "minimax-m2.5" ? ["text"] : ["text", "image"])
      // Temperature capability must be explicit; only claude-opus-4.7 is false.
      expect(model.temperature).toBe(id !== "claude-opus-4.7")
    }
  })

  test("model data sourced from SDK defaults", () => {
    // Single-source criterion: the plugin keeps NO duplicate model table —
    // every field derives 1:1 from the SDK's KIRO_MODEL_DEFAULTS catalog.
    const models = buildKiroModels()

    expect(Object.keys(models).sort()).toEqual(Object.keys(KIRO_MODEL_DEFAULTS).sort())
    for (const defaults of Object.values(KIRO_MODEL_DEFAULTS)) {
      const model = models[defaults.id]
      expect(model).toBeDefined()
      expect(model?.name).toBe(defaults.name)
      expect(model?.limit?.context).toBe(defaults.contextWindow)
      expect(model?.limit?.output).toBe(defaults.outputLimit)
      expect(model?.tool_call).toBe(defaults.toolCall)
      expect(model?.reasoning).toBe(defaults.reasoning)
      expect(model?.temperature).toBe(defaults.temperature)
      expect(model?.modalities?.input).toEqual(defaults.imageInput ? ["text", "image"] : ["text"])
    }
  })
})

describe("server hooks", () => {
  test("config hook seeds end-to-end and honors the skip rule", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj", worktree: "/tmp/wt" }))

    const cfg: Config = {}
    await hooks.config?.(cfg)
    expect(cfg.provider?.["kiro"]?.npm).toBe("kiro-acp-ai-provider")
    expect(Object.keys(cfg.provider?.["kiro"]?.models ?? {})).toHaveLength(12)

    // Idempotency through the hook surface, same as the direct seeder call.
    const sentinel = { sentinel: true }
    const preSeeded = { provider: { kiro: sentinel } } as unknown as Config
    await hooks.config?.(preSeeded)
    expect(preSeeded.provider?.["kiro"]).toBe(sentinel)
  })

  test("auth hook contract", async () => {
    const hooks = await serverPlugin.server(makeInput({ directory: "/tmp/proj", worktree: "/tmp/wt" }))

    // Exactly config + auth — deliberately NO `provider` hook: its gate
    // (provider.ts `if (!provider) continue`) no-ops for config-seeded
    // providers, so the config seed carries the full model list instead.
    expect(Object.keys(hooks).sort()).toEqual(["auth", "config"])
    expect(hooks.auth?.provider).toBe("kiro")
    expect(hooks.auth?.methods).toHaveLength(1)
    const method = hooks.auth?.methods[0]
    expect(method?.type).toBe("oauth")
    expect(method?.label).toBe("Kiro CLI Login")
    // Flow internals (browser/poll/kiro-cli) are task 10 live coverage.
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
    // export shape): no `tui` anywhere in the module namespace, while the
    // pure helpers stay importable as named exports for tests/validation.
    const mod = await importDist("server.js")

    expect("tui" in mod).toBe(false)
    expect(typeof mod.seedProviderConfig).toBe("function")
    expect(typeof mod.buildKiroModels).toBe("function")
  })
})
