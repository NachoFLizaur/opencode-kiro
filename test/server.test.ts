import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { Model, Provider, type Plugin } from "@opencode/plugin"
import type { AuthStatus, ModelWithEfforts } from "kiro-acp-ai-provider"
import { createKiroAcp, listModels, verifyAuthAsync } from "kiro-acp-ai-provider"
import { isKiroNotLoggedInError } from "kiro-acp-ai-provider"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import serverPlugin from "../src/server"
import {
  LOGOUT_FOLLOW_UP_MS,
  LOGOUT_MEMO_MS,
  LOGOUT_METADATA_KEY,
  createLogoutDetector,
  createLogoutState,
  writeLogoutFlag,
} from "../src/server/logout"
import { createRetryGuard, type RetryDecision, type RetryInput } from "../src/server/retry"

// Server plugin behavior suite. Everything is driven through
// `serverPlugin.setup(mockContext)` plus module mocks — never through module
// internals.

// Hermetic: the SDK is mocked so no kiro-cli is ever spawned and no network is
// touched; child_process.execFile is mocked so the login flow gets a fake
// killable child; login poll/timeout tests use fake timers. The mock exposes
// only the async probe: production must never use the sync `verifyAuth`, and a
// regression would fail here as a missing export.
vi.mock("kiro-acp-ai-provider", () => ({
  verifyAuthAsync: vi.fn(),
  listModels: vi.fn(),
  createKiroAcp: vi.fn(),
  isKiroNotLoggedInError: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const mockVerifyAuthAsync = vi.mocked(verifyAuthAsync)
const mockListModels = vi.mocked(listModels)
const mockCreateKiroAcp = vi.mocked(createKiroAcp)
const mockExecFile = vi.mocked(execFile)

// ---------------------------------------------------------------------------
// shared harness
// ---------------------------------------------------------------------------

/** fake killable login child returned by the mocked execFile */
function makeFakeChild() {
  return { kill: vi.fn(() => true), killed: false }
}

/** owned SDK instances created by the mocked createKiroAcp, in creation order */
let sdkInstances: Array<{
  languageModel: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}> = []

function makeSdkInstance() {
  const instance = {
    languageModel: vi.fn((modelId: string) => ({ modelId })),
    shutdown: vi.fn(async () => {}),
  }
  sdkInstances.push(instance)
  return instance
}

/**
 * Controllable async event stream backing `context.event.subscribe()`.
 * `push()` delivers one event to the (single) consumer; `return()` is a spy so
 * cleanup's iterator shutdown is observable.
 */
function createEventStream() {
  const queue: unknown[] = []
  let notify: (() => void) | undefined
  let ended = false
  const wake = () => {
    const resolve = notify
    notify = undefined
    resolve?.()
  }
  const returned = vi.fn(async () => {
    ended = true
    wake()
    return { value: undefined, done: true as const }
  })
  const iterator = {
    async next(): Promise<IteratorResult<unknown>> {
      while (true) {
        if (queue.length > 0) return { value: queue.shift(), done: false }
        if (ended) return { value: undefined, done: true }
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    },
    return: returned,
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return {
    iterable: iterator as AsyncIterable<unknown>,
    push(event: unknown) {
      queue.push(event)
      wake()
    },
    returned,
  }
}

/** hand-built IntegrationDraft mock recording upserts + method registrations */
function makeIntegrationDraft() {
  const integrations = new Map<string, { id: string; name: string }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods: any[] = []
  const draft = {
    list: () => [...integrations.values()],
    get: (id: string) => integrations.get(id),
    update(id: string, update: (integration: { id: string; name: string }) => void) {
      const record = integrations.get(id) ?? { id, name: "" }
      update(record)
      integrations.set(id, record)
    },
    remove(id: string) {
      integrations.delete(id)
    },
    method: {
      list: () => [],
      update(registration: unknown) {
        methods.push(registration)
      },
      remove() {},
    },
  }
  return { draft, integrations, methods }
}

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]
type ProviderRecord = NonNullable<ReturnType<ProviderEditor["get"]>>
type MutableProvider = Parameters<Parameters<ProviderEditor["update"]>[1]>[0]
type MutableModel = Parameters<Parameters<ProviderEditor["models"]["update"]>[2]>[0]

/** Freeze nested source-model data so bypassing the editor fails at the write. */
function freezeModel(model: Model.Info): Model.Info {
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(model)
  return model
}

/**
 * ProviderEditor mock using the host's default constructors. `get` never
 * upserts; `update`/`models.update` initialize missing records. Record model
 * values are frozen before publication and updates clone them before invoking
 * the callback. Direct model writes therefore throw instead of silently
 * bypassing the editor; this protection is always on, including for seeds.
 */
function makeProviderEditor() {
  const providers = new Map<
    string,
    {
      provider: Provider.Info
      models: Map<string, Model.Info>
      sourceConnection?: ProviderRecord["sourceConnection"]
    }
  >()
  const ensureProvider = (providerID: string) => {
    let record = providers.get(providerID)
    if (record === undefined) {
      record = { provider: Provider.Info.empty(Provider.ID.make(providerID)), models: new Map() }
      providers.set(providerID, record)
    }
    return record
  }
  const indexModels = (providerID: string, models: readonly Model.Info[]) =>
    new Map(models.map((model) => [
      model.id,
      freezeModel({ ...structuredClone(model), providerID: Provider.ID.make(providerID) }),
    ]))
  const editor: ProviderEditor = {
    list: () => [...providers.values()],
    get: (providerID) => providers.get(providerID),
    add({ info, models, sourceConnection }) {
      providers.set(info.id, {
        provider: structuredClone(info),
        models: indexModels(info.id, models),
        sourceConnection,
      })
    },
    update(providerID, update) {
      const record = ensureProvider(providerID)
      const provider = structuredClone(record.provider) as MutableProvider
      update(provider)
      provider.id = Provider.ID.make(providerID)
      record.provider = provider as Provider.Info
    },
    remove(providerID) {
      providers.delete(providerID)
    },
    models: {
      set(providerID, models) {
        ensureProvider(providerID).models = indexModels(providerID, models)
      },
      update(providerID, modelID, update) {
        const record = ensureProvider(providerID)
        const current = record.models.get(modelID)
        const model = (current
          ? structuredClone(current)
          : Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID))) as MutableModel
        update(model)
        model.id = Model.ID.make(modelID)
        model.providerID = Provider.ID.make(providerID)
        // DeepMutable expands branded strings; their runtime values stay strings.
        record.models.set(modelID, freezeModel(model as unknown as Model.Info))
      },
      remove(providerID, modelID) {
        providers.get(providerID)?.models.delete(modelID)
      },
    },
  }
  return { editor, providers: providers as ReadonlyMap<string, ProviderRecord> }
}

/** Seed rich source models with explicit empty settings and unknown limits. */
function seedRichKiro(
  provider: ReturnType<typeof makeProviderEditor>,
  models: Array<{ key: string; modelID: string; [extra: string]: unknown }>,
) {
  for (const { key, modelID, ...extra } of models) {
    provider.editor.models.update("kiro", key, (model) => {
      model.modelID = Model.ID.make(modelID)
      model.name = ""
      model.settings = {}
      model.limit = { context: 0, output: 0 }
      Object.assign(model, extra)
    })
  }
}

/** runtime ModelWithEfforts factory */
function runtime(modelId: string, over: Partial<ModelWithEfforts> = {}): ModelWithEfforts {
  return { modelId, name: modelId, runtimeEfforts: [], ...over }
}

const tmpDirs: string[] = []

/**
 * Mock plugin context: records the registered integration/provider transform
 * callbacks, the sdk hook callback and the session hook callback, exposes
 * controllable connection state, spied reloads, a controllable event stream,
 * and per-registration disposer spies. `integration.list()` yields a hermetic
 * temp directory location.
 *
 * `options` is absent by default (the key is not even present), so every
 * default-path test exercises the `context.options ?? {}` guard in
 * src/server.ts. Option tests opt in via `makeMockContext({ options: {...} })`.
 */
function makeMockContext(init: { options?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiro-v2-test-"))
  tmpDirs.push(directory)

  let integrationTransformCb: ((draft: unknown) => void) | undefined
  let providerTransformCb: ((editor: ProviderEditor) => void) | undefined
  // aisdk registrations stored by hook name: setup registers both the "sdk"
  // and the "language" hooks, each with its own dispose spy so
  // per-registration exactly-once disposal is observable.
  const aisdkHooks = new Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (event: any) => Promise<void> | void
      options: unknown
      dispose: ReturnType<typeof vi.fn>
    }
  >()
  // session hook registrations by name ("context" for the logout detector),
  // with their own dispose spies separate from the aisdk hook knob
  const sessionHooks = new Map<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (input: any) => Promise<void> | void
      options: unknown
      dispose: ReturnType<typeof vi.fn>
    }
  >()

  const disposeSpies = {
    integration: vi.fn(async () => {}),
    provider: vi.fn(async () => {}),
    // shared hook-disposal knob: every per-registration dispose spy delegates
    // here so failure injection (mockRejectedValue) hits all hook disposers
    hook: vi.fn(async () => {}),
    session: vi.fn(async () => {}),
  }
  const reload = vi.fn(async () => {})
  const integrationReload = vi.fn(async () => {})
  const active = vi.fn(async (): Promise<unknown> => undefined)
  const events = createEventStream()

  const raw = {
    integration: {
      transform: vi.fn(async (cb: (draft: unknown) => void) => {
        integrationTransformCb = cb
        return { dispose: disposeSpies.integration }
      }),
      list: vi.fn(async () => ({ location: { directory } })),
      connection: { active, resolve: vi.fn(async () => undefined) },
      reload: integrationReload,
    },
    provider: {
      transform: vi.fn(async (cb: (editor: ProviderEditor) => void) => {
        providerTransformCb = cb
        return { dispose: disposeSpies.provider }
      }),
      reload,
    },
    session: {
      // hook(name, cb, options?) with ModelHookOptions {providerID?}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: vi.fn(async (name: string, cb: (input: any) => Promise<void> | void, options?: unknown) => {
        const dispose = vi.fn(async () => disposeSpies.session())
        sessionHooks.set(name, { cb, options, dispose })
        return { dispose }
      }),
    },
    aisdk: {
      // hook(name, cb, options?) with ModelHookOptions {providerID?}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: vi.fn(async (name: string, cb: (event: any) => Promise<void> | void, options?: unknown) => {
        const dispose = vi.fn(async () => disposeSpies.hook())
        aisdkHooks.set(name, { cb, options, dispose })
        return { dispose }
      }),
    },
    event: { subscribe: vi.fn(() => events.iterable) },
    // present only when a test opts in — see the docblock above
    ...(init.options !== undefined ? { options: init.options } : {}),
  }

  return {
    context: raw as unknown as Plugin.Context,
    raw,
    directory,
    reload,
    integrationReload,
    active,
    events,
    disposeSpies,
    /** aisdk hook registrations by name ("sdk" / "language") */
    hooks: aisdkHooks,
    /** session hook registrations by name ("context") */
    sessionHooks,
    integrationTransform: (draft: unknown) => {
      if (integrationTransformCb === undefined) throw new Error("integration transform not registered")
      integrationTransformCb(draft)
    },
    providerTransform: (editor: ProviderEditor) => {
      if (providerTransformCb === undefined) throw new Error("provider transform not registered")
      providerTransformCb(editor)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkHook: (event: any) => {
      const registration = aisdkHooks.get("sdk")
      if (registration === undefined) throw new Error("sdk hook not registered")
      return registration.cb(event)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    languageHook: (event: any) => {
      const registration = aisdkHooks.get("language")
      if (registration === undefined) throw new Error("language hook not registered")
      return registration.cb(event)
    },
    getSdkHookName: () => (aisdkHooks.has("sdk") ? "sdk" : undefined),
    getSdkHookOptions: () => aisdkHooks.get("sdk")?.options,
  }
}

type Harness = ReturnType<typeof makeMockContext>

/** drain macrotask+microtask chains (event consumer, fire-and-forget discovery) */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** run setup, asserting the contract that it returns a Cleanup function */
async function runSetup(h: Harness): Promise<() => Promise<void> | void> {
  const cleanup = await serverPlugin.setup(h.context)
  if (typeof cleanup !== "function") throw new Error("setup must return a cleanup function")
  return cleanup
}

/** run setup and capture the OAuth authorize() registered via the integration transform */
async function setupWithAuthorize(h: Harness) {
  const cleanup = await runSetup(h)
  const integration = makeIntegrationDraft()
  h.integrationTransform(integration.draft)
  const registration = integration.methods[0]
  expect(registration).toBeDefined()
  return {
    cleanup,
    authorize: registration.authorize as (
      inputs: Record<string, string>,
    ) => Promise<{ url: string; instructions: string; mode: string; callback: Promise<unknown> }>,
  }
}

const kiroEvent = () => ({ type: "integration.connection.updated", data: { integrationID: "kiro" } })

// current-host credential events (`integration.connection.updated` was
// replaced upstream by `credential.updated` + `credential.switched`)
const credentialUpdatedEvent = () => ({ type: "credential.updated", data: {} })
const credentialSwitchedEvent = (integrationID: string, credentialID: string | null) => ({
  type: "credential.switched",
  data: { integrationID, credentialID },
})

const EXPECTED_CREDENTIAL = {
  type: "oauth",
  methodID: "kiro-cli-login",
  refresh: "",
  access: "kiro-cli",
  expires: 0,
}

beforeEach(() => {
  sdkInstances = []
  mockVerifyAuthAsync.mockReset()
  mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: true })
  mockListModels.mockReset()
  mockListModels.mockResolvedValue([])
  mockCreateKiroAcp.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateKiroAcp.mockImplementation(() => makeSdkInstance() as any)
  mockExecFile.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation(() => makeFakeChild() as any)
})

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Integration/Credential auth flow
// ---------------------------------------------------------------------------

describe("auth: Integration kiro + Kiro CLI Login OAuth", () => {
  test("server plugin definition has no tui flag", () => {
    // The typed Plugin.Plugin definition leaves TUI discovery to the ./tui export.
    expect("tui" in serverPlugin).toBe(false)
  })

  test("registers integration kiro with a forms-shaped oauth method (no prompts anywhere)", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const integration = makeIntegrationDraft()
    h.integrationTransform(integration.draft)

    expect(integration.integrations.get("kiro")).toEqual({ id: "kiro", name: "Kiro" })
    expect(integration.methods).toHaveLength(1)
    const registration = integration.methods[0]
    expect(registration.integrationID).toBe("kiro")
    // exact IntegrationOAuthMethod shape: {id, type:"oauth", label}; the flow
    // needs no form fields, so the optional `form` is omitted
    expect(Object.keys(registration.method).sort()).toEqual(["id", "label", "type"])
    expect(registration.method).toEqual({
      id: "kiro-cli-login",
      type: "oauth",
      label: "Kiro CLI Login",
    })
    // the older prompts/select-question API no longer exists upstream: no
    // `prompts` key may appear on the registration or the method
    expect("prompts" in registration).toBe(false)
    expect("prompts" in registration.method).toBe(false)
    // authorize takes the Form.Answer argument
    expect(typeof registration.authorize).toBe("function")
    expect(registration.authorize.length).toBe(1)
    // kiro-cli owns credential storage/refresh: no refresh callback registered
    expect(registration.refresh).toBeUndefined()

    await cleanup()
  })

  test("cli absent fails with install guidance, no spawn, no credential", async () => {
    mockVerifyAuthAsync.mockResolvedValue({ installed: false, authenticated: false })
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    await expect(authorize({})).rejects.toThrow(/Install it from https:\/\/kiro\.dev\/docs\/cli\//)
    expect(mockExecFile).not.toHaveBeenCalled()

    await cleanup()
  })

  test("already authenticated resolves immediately with Credential.OAuth", async () => {
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: true })
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})

    expect(mockExecFile).not.toHaveBeenCalled()
    expect(authorization.mode).toBe("auto")
    await expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await cleanup()
  })

  test("authorize(answer) spawns kiro-cli and polls to success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    mockVerifyAuthAsync.mockImplementation(async () => ({ installed: true, authenticated }))
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // Form.Answer argument: the method registers no form fields, so any answer
    // record — including a stray one — enters the same login flow
    const authorization = await authorize({ unused: "answer" })
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledWith("kiro-cli", ["login"], { shell: false })
    expect(authorization.mode).toBe("auto")

    // poll observes authenticated -> child stops,
    // Credential.OAuth {type:"oauth", refresh:"", expires:0} resolves
    const credential = expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await vi.advanceTimersByTimeAsync(2_000) // 1st poll: still unauthenticated
    expect(child.kill).not.toHaveBeenCalled()

    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // 2nd poll: success

    await credential
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("win32 uses shell for the login spawn", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })

      const h = makeMockContext()
      const { cleanup, authorize } = await setupWithAuthorize(h)

      // no catch handler is attached to the callback here on purpose: the
      // production guard in auth.ts absorbs the cancellation raised by cleanup
      // below, and vitest fails on unhandled rejections, so this test also
      // verifies that guard
      const authorization = await authorize({})
      expect(authorization.mode).toBe("auto")

      expect(mockExecFile).toHaveBeenCalledWith("kiro-cli", ["login"], { shell: true })

      await cleanup()
    } finally {
      if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform)
    }
  })

  test("timeout kills child and carries manual kiro-cli login guidance", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/`kiro-cli login`/)

    await vi.advanceTimersByTimeAsync(121_000) // > 120s poll budget

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("disposal mid-poll kills child, settles the attempt, clears timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/cancelled/)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await cleanup()

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("no auth.json/tui.json references anywhere in src/", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src")
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8")
      expect(content, `${file} must not reference auth.json/tui.json`).not.toMatch(
        /auth\.json|tui\.json/,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// provider transform + discovery lifecycle
// ---------------------------------------------------------------------------

describe("discovery: provider transform + runtime model lifecycle", () => {
  test("successful discovery publishes exact case-sensitive intersection and reloads once", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6", { name: "Sonnet" })])

    const cleanup = await runSetup(h)
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(h.reload).toHaveBeenCalledTimes(1)

    const provider = makeProviderEditor()
    seedRichKiro(provider, [
      { key: "sonnet", modelID: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", release: "2025" },
      { key: "sonnet-case", modelID: "Claude-Sonnet-4.6" }, // case mismatch -> removed
      { key: "unrelated", modelID: "other-model" }, // not in runtime -> removed
    ])
    h.providerTransform(provider.editor)

    const record = provider.providers.get("kiro")
    expect(record).toBeDefined()
    expect([...record!.models.keys()]).toEqual(["sonnet"])
    // rich models.dev metadata survives the transform
    expect(record!.models.get("sonnet")).toMatchObject({
      modelID: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      release: "2025",
    })
    expect(record!.provider).toMatchObject({
      name: "Kiro",
      integrationID: "kiro",
      package: "aisdk:kiro-acp-ai-provider",
    })

    await cleanup()
  })

  test("duplicate runtime modelId fails open: snapshot unchanged, no reload", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("dupe"), runtime("dupe")])

    const cleanup = await runSetup(h)
    await flush()

    expect(h.reload).not.toHaveBeenCalled()

    // no snapshot was published: the transform must leave provider data untouched
    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "existing", modelID: "existing-model" }])
    h.providerTransform(provider.editor)
    expect([...provider.providers.get("kiro")!.models.keys()]).toEqual(["existing"])

    await cleanup()
  })

  test("listModels exception fails open: previous snapshot retained", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    mockListModels.mockRejectedValue(new Error("acp transport down"))
    h.events.push(kiroEvent())
    await flush()

    // failed rediscovery: no reload of partial data, last known-good survives
    expect(h.reload).toHaveBeenCalledTimes(1)
    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "a", modelID: "model-a" }])
    h.providerTransform(provider.editor)
    expect([...provider.providers.get("kiro")!.models.keys()]).toEqual(["a"])

    await cleanup()
  })

  test("login event rechecks connection.active and rediscovers", async () => {
    const h = makeMockContext()
    // not connected at setup: no initial discovery
    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).not.toHaveBeenCalled()
    const activeCallsAtSetup = h.active.mock.calls.length

    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    h.events.push(kiroEvent())
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("non-kiro connection events are ignored", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    await flush()
    const activeCallsAtSetup = h.active.mock.calls.length

    h.events.push({ type: "integration.connection.updated", data: { integrationID: "other" } })
    h.events.push({ type: "session.updated", data: { integrationID: "kiro" } })
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("logout clears the snapshot and reloads without runtime-only models", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    h.active.mockResolvedValue(undefined) // logged out
    h.events.push(kiroEvent())
    await flush()

    expect(h.reload).toHaveBeenCalledTimes(2)
    // fallback-shaped editor (no models.dev entry): nothing self-registers now
    const provider = makeProviderEditor()
    h.providerTransform(provider.editor)
    expect(provider.providers.size).toBe(0)

    await cleanup()
  })

  test("stale discovery completing after logout is discarded by the generation guard", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    let resolveModels!: (models: ModelWithEfforts[]) => void
    mockListModels.mockImplementation(
      () => new Promise<ModelWithEfforts[]>((resolve) => (resolveModels = resolve)),
    )

    const cleanup = await runSetup(h)
    await flush() // initial discovery in flight

    h.active.mockResolvedValue(undefined)
    h.events.push(kiroEvent()) // logout bumps the generation + reloads
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    resolveModels([runtime("stale-model")])
    await flush()

    // stale completion dropped: no republish, snapshot stays empty
    expect(h.reload).toHaveBeenCalledTimes(1)
    const provider = makeProviderEditor()
    h.providerTransform(provider.editor)
    expect(provider.providers.size).toBe(0)

    await cleanup()
  })

  test("concurrent discovery triggers coalesce onto one listModels call", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    let resolveModels!: (models: ModelWithEfforts[]) => void
    mockListModels.mockImplementation(
      () => new Promise<ModelWithEfforts[]>((resolve) => (resolveModels = resolve)),
    )

    const cleanup = await runSetup(h)
    await flush() // setup discovery in flight

    // second trigger while the setup discovery is still in flight
    h.events.push(kiroEvent())
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(1)

    resolveModels([runtime("model-a")])
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("effort variants merge into settings and variants; empty efforts invent nothing", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["low", "high"], baselineEffort: "low" }),
      runtime("no-efforts", { runtimeEfforts: [] }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const provider = makeProviderEditor()
    seedRichKiro(provider, [
      { key: "with-efforts", modelID: "with-efforts" },
      { key: "no-efforts", modelID: "no-efforts" },
    ])
    h.providerTransform(provider.editor)

    const models = provider.providers.get("kiro")!.models
    // the emitted settings key is the SDK's `effort`
    // (KiroACPProviderSettings, dist/index.d.ts) — never `reasoningEffort`
    expect(models.get("with-efforts")!.settings!.effort).toBe("low")
    expect(models.get("with-efforts")!.settings!.reasoningEffort).toBeUndefined()
    expect(models.get("with-efforts")!.variants).toEqual([
      { id: "low", settings: { effort: "low" } },
      { id: "high", settings: { effort: "high" } },
    ])
    expect(models.get("no-efforts")!.variants).toEqual([])
    expect(models.get("no-efforts")!.settings!.effort).toBeUndefined()

    await cleanup()
  })

  test("fallback self-registers only runtime models when the catalog lacks Kiro", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("model-a", { name: "Model A" }),
      runtime("model-b", { name: "" }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const provider = makeProviderEditor() // no models.dev Kiro entry
    h.providerTransform(provider.editor)

    const record = provider.providers.get("kiro")
    expect(record).toBeDefined()
    expect([...record!.models.keys()].sort()).toEqual(["model-a", "model-b"])
    expect(record!.models.get("model-a")).toMatchObject({ name: "Model A", modelID: "model-a" })
    expect(record!.models.get("model-b")!.name).toBe("model-b") // falls back to the id
    expect(record!.provider.package).toBe("aisdk:kiro-acp-ai-provider")
    expect(record!.provider.name).toBe("Kiro")

    await cleanup()
  })

  test("provider settings contextWindows are keyed by API modelID with positive values only", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6"), runtime("zero-limit")])
    const cleanup = await runSetup(h)
    await flush()

    const provider = makeProviderEditor()
    seedRichKiro(provider, [
      // catalog key differs from the API modelID on purpose
      { key: "sonnet-alias", modelID: "claude-sonnet-4.6", limit: { context: 200_000, output: 64_000 } },
      { key: "zero-alias", modelID: "zero-limit", limit: { context: 0, output: 0 } },
    ])
    h.providerTransform(provider.editor)

    const settings = provider.providers.get("kiro")!.provider.settings!
    expect(settings.contextWindows).toEqual({ "claude-sonnet-4.6": 200_000 })
    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// credential events on legacy and current hosts
// ---------------------------------------------------------------------------

describe("discovery: provider editor contract", () => {
  const forbiddenReads: Array<ReturnType<typeof vi.fn>> = []

  /**
   * Install read traps before setup so even caught accesses to obsolete domains
   * fail the test at teardown. The traps stay enabled through cleanup.
   */
  function guardedContext(init: Parameters<typeof makeMockContext>[0] = {}) {
    const h = makeMockContext(init)
    const forbidden = vi.fn(() => { throw new Error("unexpected discovery domain") })
    forbiddenReads.push(forbidden)
    Object.defineProperty(h.raw, "catalog", { get: forbidden })
    Object.defineProperty(h.raw, "model", {
      value: Object.defineProperty({}, "transform", { get: forbidden }),
    })
    return h
  }

  afterEach(() => {
    for (const read of forbiddenReads.splice(0)) expect(read).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  test("registers one provider transform and reloads only the provider on retry publication and inactivity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const h = guardedContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce([runtime("model-a")])
    const cleanup = await runSetup(h)
    await flush()

    expect(h.raw.provider.transform.mock.calls).toEqual([[expect.any(Function)]])
    expect(h.raw.provider.reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    expect(h.raw.provider.reload.mock.calls).toEqual([[]])
    const published = makeProviderEditor()
    h.providerTransform(published.editor)
    expect([...published.providers.get("kiro")!.models.keys()]).toEqual(["model-a"])

    h.active.mockResolvedValue(undefined)
    h.events.push(credentialUpdatedEvent())
    await flush()
    expect(h.raw.provider.reload.mock.calls).toEqual([[], []])
    expect(h.integrationReload).not.toHaveBeenCalled()
    const cleared = makeProviderEditor()
    h.providerTransform(cleared.editor)
    expect(cleared.providers.size).toBe(0)
    expect(h.raw.provider.transform).toHaveBeenCalledTimes(1)
    await cleanup()
    expect(h.disposeSpies.provider).toHaveBeenCalledTimes(1)
  })

  test.each([undefined, { afterMs: 12_000, live: "off" }])(
    "rich seed prunes by API id and updates efforts and full provider settings (stall=%j)",
    async (stall) => {
      const h = guardedContext({ options: { agent: "custom", mcpTimeout: 12, ...(stall ? { stall } : {}) } })
      h.active.mockResolvedValue({ integrationID: "kiro" })
      mockListModels.mockResolvedValue([
        runtime("runtime-a", { runtimeEfforts: ["low", "high"], baselineEffort: "low" }),
        runtime("runtime-only"),
      ])
      const cleanup = await runSetup(h)
      await flush()
      const provider = makeProviderEditor()
      seedRichKiro(provider, [
        {
          key: "alias-a", modelID: "runtime-a", name: "Rich A",
          limit: { context: 200_000, output: 8_000 }, settings: { retained: true },
          variants: [{ id: "high", settings: { retained: true } }, { id: "custom", settings: {} }],
        },
        { key: "case-mismatch", modelID: "Runtime-a" },
        { key: "absent", modelID: "absent" },
      ])
      provider.editor.update("kiro", (info) => { info.settings = { retained: true } })
      const before = provider.providers.get("kiro")!.models.get("alias-a")!
      const update = vi.spyOn(provider.editor, "update")
      const updateModel = vi.spyOn(provider.editor.models, "update")
      const removeModel = vi.spyOn(provider.editor.models, "remove")
      h.providerTransform(provider.editor)

      expect(update.mock.calls).toEqual([["kiro", expect.any(Function)]])
      expect(updateModel.mock.calls).toEqual([["kiro", "alias-a", expect.any(Function)]])
      expect(removeModel.mock.calls).toEqual([["kiro", "case-mismatch"], ["kiro", "absent"]])
      const record = provider.providers.get("kiro")!
      expect([...record.models.keys()]).toEqual(["alias-a"])
      expect(record.models.get("alias-a")).toEqual({
        ...before,
        settings: { retained: true, effort: "low" },
        variants: [
          { id: "high", settings: { retained: true, effort: "high" } },
          { id: "custom", settings: {} },
          { id: "low", settings: { effort: "low" } },
        ],
      })
      expect(before.settings).toEqual({ retained: true })
      expect(Object.isFrozen(before.variants)).toBe(true)
      expect(record.provider).toEqual({
        ...Provider.Info.empty(Provider.ID.make("kiro")),
        name: "Kiro", integrationID: "kiro", package: "aisdk:kiro-acp-ai-provider",
        settings: {
          retained: true, cwd: h.directory, agent: "custom", trustAllTools: true, mcpTimeout: 12,
          ...(stall ? { stall } : {}), contextWindows: { "runtime-a": 200_000 },
        },
      })
      expect(h.raw.provider.reload).toHaveBeenCalledTimes(1)
      await cleanup()
    },
  )

  test.each(["absent", "empty"])("%s seed publishes runtime models with the host default context window", async (seed) => {
    const h = guardedContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("model-a", { name: "Model A", runtimeEfforts: ["high"], baselineEffort: "high" }),
      runtime("model-b", { name: "" }),
    ])
    const cleanup = await runSetup(h)
    await flush()
    const provider = makeProviderEditor()
    expect(provider.editor.get("kiro")).toBeUndefined()
    expect(() => provider.editor.models.remove("kiro", "missing")).not.toThrow()
    expect(provider.providers.size).toBe(0)
    if (seed === "empty") provider.editor.update("kiro", () => {})
    const updateModel = vi.spyOn(provider.editor.models, "update")
    const update = vi.spyOn(provider.editor, "update")
    h.providerTransform(provider.editor)

    // With no seeded models, the fallback publishes the host default context window.
    expect(updateModel.mock.calls).toEqual([
      ["kiro", "model-a", expect.any(Function)], ["kiro", "model-b", expect.any(Function)],
    ])
    expect(update.mock.calls).toEqual([["kiro", expect.any(Function)]])
    const record = provider.providers.get("kiro")!
    expect([...record.models.keys()]).toEqual(["model-a", "model-b"])
    expect(record.models.get("model-a")).toEqual({
      ...Model.Info.default(Provider.ID.make("kiro"), Model.ID.make("model-a")),
      modelID: "model-a", name: "Model A", settings: { effort: "high" },
      variants: [{ id: "high", settings: { effort: "high" } }],
    })
    expect(record.models.get("model-b")).toEqual({
      ...Model.Info.default(Provider.ID.make("kiro"), Model.ID.make("model-b")),
      modelID: "model-b", name: "model-b",
    })
    const defaultContext = Model.Info.default(Provider.ID.make("kiro"), Model.ID.make("model-a")).limit.context
    expect(record.provider).toEqual({
      ...Provider.Info.empty(Provider.ID.make("kiro")),
      name: "Kiro", integrationID: "kiro", package: "aisdk:kiro-acp-ai-provider",
      settings: {
        cwd: h.directory, agent: "opencode", trustAllTools: true, mcpTimeout: 45,
        contextWindows: { "model-a": defaultContext, "model-b": defaultContext },
      },
    })
    await cleanup()
  })

  test.each(["empty", "duplicate"])("%s runtime result leaves the entire rich record untouched", async (result) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const h = guardedContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue(result === "empty" ? [] : [runtime("dupe"), runtime("dupe")])
    const cleanup = await runSetup(h)
    await flush()
    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "existing", modelID: "existing-model", name: "Existing" }])
    const before = structuredClone(provider.providers.get("kiro"))
    const update = vi.spyOn(provider.editor, "update")
    const updateModel = vi.spyOn(provider.editor.models, "update")
    const removeModel = vi.spyOn(provider.editor.models, "remove")
    h.providerTransform(provider.editor)
    expect(provider.providers.get("kiro")).toEqual(before)
    expect(update).not.toHaveBeenCalled()
    expect(updateModel).not.toHaveBeenCalled()
    expect(removeModel).not.toHaveBeenCalled()
    expect(h.raw.provider.reload).toHaveBeenCalledTimes(result === "empty" ? 1 : 0)
    await cleanup()
  })
})

describe("discovery: credential events on legacy and current hosts", () => {
  /** setup while disconnected: no initial discovery, a clean call baseline */
  async function setupDisconnected() {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).not.toHaveBeenCalled()
    return { h, cleanup, activeCallsAtSetup: h.active.mock.calls.length }
  }

  test("legacy integration.connection.updated (kiro) still triggers re-check + discovery", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    h.events.push(kiroEvent())
    await flush()

    // legacy-host path stays alive: the legacy event name must still be handled
    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("credential.updated (empty payload) triggers re-check + discovery", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    // the new-host event carries no payload — there is nothing to scope on;
    // the connection.active re-check is the scoping
    h.events.push(credentialUpdatedEvent())
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("credential.switched (kiro) triggers re-check + discovery; nullable credentialID accepted", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])

    h.events.push(credentialSwitchedEvent("kiro", "credential-1"))
    await flush()

    expect(h.active.mock.calls.length).toBeGreaterThan(activeCallsAtSetup)
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    // credentialID is NullOr<Credential.ID> upstream (null on sign-out of the
    // active credential): a null value must trigger exactly the same re-check
    h.events.push(credentialSwitchedEvent("kiro", null))
    await flush()

    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(h.reload).toHaveBeenCalledTimes(2)

    await cleanup()
  })

  test("credential.switched for another integration is ignored", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()

    h.events.push(credentialSwitchedEvent("github", "credential-y"))
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("unknown event names are ignored", async () => {
    const { h, cleanup, activeCallsAtSetup } = await setupDisconnected()

    h.events.push({ type: "something.else", data: { integrationID: "kiro" } })
    await flush()

    expect(h.active.mock.calls.length).toBe(activeCallsAtSetup)
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    await cleanup()
  })

  test("re-check is the source of truth: credential.updated while inactive clears kiro models", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("model-a")])
    const cleanup = await runSetup(h)
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)

    // logout observed only through the new event name: the event payload is
    // empty, so connection.active alone must drive the clear
    h.active.mockResolvedValue(undefined)
    h.events.push(credentialUpdatedEvent())
    await flush()

    expect(h.reload).toHaveBeenCalledTimes(2)
    // snapshot cleared: a fallback-shaped editor publishes no kiro models
    const provider = makeProviderEditor()
    h.providerTransform(provider.editor)
    expect(provider.providers.size).toBe(0)

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// discovery resilience: probe deadline, bounded retry, stderr reporting
// ---------------------------------------------------------------------------

describe("discovery: probe deadline, bounded retry and one probe per login", () => {
  // discovery constants (discovery.ts DISCOVERY_TIMEOUT_MS / RETRY_BACKOFF_MS)
  const PROBE_DEADLINE_MS = 60_000
  const BACKOFF_MS = [5_000, 20_000, 60_000]
  const LOG_LINE = /^\[opencode-kiro\] model discovery failed for /

  let errorSpy: ReturnType<typeof spyOnConsoleError>

  /** silent console.error spy: stderr is the plugin's only diagnostics channel */
  function spyOnConsoleError() {
    return vi.spyOn(console, "error").mockImplementation(() => {})
  }

  beforeEach(() => {
    errorSpy = spyOnConsoleError()
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  /** manually-controlled listModels result */
  function deferredModels() {
    let resolve!: (models: ModelWithEfforts[]) => void
    const promise = new Promise<ModelWithEfforts[]>((r) => (resolve = r))
    return { promise, resolve }
  }

  /** the kiro model keys a rich provider editor publishes after the transform */
  function publishedModels(h: Harness, seeds: string[]): string[] {
    const provider = makeProviderEditor()
    seedRichKiro(
      provider,
      seeds.map((id) => ({ key: id, modelID: id })),
    )
    h.providerTransform(provider.editor)
    return [...(provider.providers.get("kiro")?.models.keys() ?? [])]
  }

  /** every stderr line written so far, as strings */
  function errorLines(): string[] {
    return errorSpy.mock.calls.map((call) => String(call[0]))
  }

  test("a probe that exceeds the deadline is reported on stderr and the retry recovers the catalog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    const hung = deferredModels() // never settles
    mockListModels
      .mockImplementationOnce(() => hung.promise)
      .mockResolvedValueOnce([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // the probe deadline

    // nothing happens before the deadline
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1)
    expect(errorSpy).not.toHaveBeenCalled()

    // deadline: one stderr line naming the location, the attempt and the next step
    await vi.advanceTimersByTimeAsync(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = errorLines()[0]!
    expect(line).toMatch(LOG_LINE)
    expect(line).toContain(h.directory)
    expect(line).toMatch(/\(attempt 1\/4\)/)
    expect(line).toMatch(/no response after 60s/)
    expect(line).toMatch(/retrying in 5s$/)
    expect(h.reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1) // the retry, not the deadline

    // first backoff step: the retry probes again and publishes
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(mockListModels).toHaveBeenNthCalledWith(2, { cwd: h.directory })
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(publishedModels(h, ["model-a", "other"])).toEqual(["model-a"])
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("a late result that arrives before the retry fires is applied and cancels the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    const slow = deferredModels()
    mockListModels.mockImplementation(() => slow.promise)

    const cleanup = await runSetup(h)
    await flush()

    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // retry pending

    // the abandoned probe answers for the still-current generation
    slow.resolve([runtime("model-a")])
    await flush()

    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(publishedModels(h, ["model-a"])).toEqual(["model-a"])
    expect(vi.getTimerCount()).toBe(0) // the retry became redundant

    // no second probe ever runs
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * 2)
    expect(mockListModels).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("a late result from an abandoned probe is discarded once a retry has superseded it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    const first = deferredModels()
    const second = deferredModels()
    mockListModels.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)

    const cleanup = await runSetup(h)
    await flush()

    // deadline, then the retry starts a fresh probe (new generation)
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS + BACKOFF_MS[0]!)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(2)

    // the abandoned first probe answers now: superseded, so nothing is published
    first.resolve([runtime("stale-model")])
    await flush()
    expect(h.reload).not.toHaveBeenCalled()
    const beforeFresh = makeProviderEditor() // fallback-shaped: nothing self-registers without a snapshot
    h.providerTransform(beforeFresh.editor)
    expect(beforeFresh.providers.size).toBe(0)

    // the current probe's answer is the one that lands
    second.resolve([runtime("fresh-model")])
    await flush()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(publishedModels(h, ["stale-model", "fresh-model"])).toEqual(["fresh-model"])

    await cleanup()
  })

  test("a failed probe is not retried once the connection is no longer active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockRejectedValue(new Error("acp transport down"))

    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorLines()[0]).toMatch(/acp transport down; retrying in 5s$/)
    expect(vi.getTimerCount()).toBe(1) // retry pending

    // logout before the backoff elapses
    h.active.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]!)
    await flush()

    // the retry tick re-checked the connection and ended the chain quietly
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS * 3)
    expect(mockListModels).toHaveBeenCalledTimes(1)

    await cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a new discovery supersedes the pending retry so only one attempt chain runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockRejectedValueOnce(new Error("first attempt failed")).mockResolvedValue([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // retry pending

    // a credential event lands while the retry is pending: fresh chain, fresh probe
    h.events.push(credentialUpdatedEvent())
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0) // the old retry was cancelled, not left to fire

    // the old backoff window passes without a third probe
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]! * 2)
    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("cleanup clears a pending probe deadline and a pending retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })

    // pending deadline: the probe never answers
    const hung = deferredModels()
    mockListModels.mockImplementation(() => hung.promise)
    const h1 = makeMockContext()
    h1.active.mockResolvedValue({ integrationID: "kiro" })
    const cleanup1 = await runSetup(h1)
    await flush()
    expect(vi.getTimerCount()).toBe(1)

    await cleanup1()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS * 2)
    expect(errorSpy).not.toHaveBeenCalled() // no deadline fired after disposal
    expect(mockListModels).toHaveBeenCalledTimes(1)

    // pending retry: the probe failed and the backoff is scheduled
    mockListModels.mockRejectedValue(new Error("acp transport down"))
    const h2 = makeMockContext()
    h2.active.mockResolvedValue({ integrationID: "kiro" })
    const cleanup2 = await runSetup(h2)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await cleanup2()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS * 2)
    expect(mockListModels).toHaveBeenCalledTimes(2) // no retry after disposal
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test("backoff is bounded: four attempts, then the chain gives up until the next credential change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockRejectedValue(new Error("acp transport down"))

    // setup resolves even though discovery is failing (fail open)
    const cleanup = await runSetup(h)
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)

    // each backoff step yields exactly one more attempt
    let attempts = 1
    for (const delay of BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(mockListModels).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      await flush()
      attempts += 1
      expect(mockListModels).toHaveBeenCalledTimes(attempts)
    }
    expect(mockListModels).toHaveBeenCalledTimes(4)

    // every attempt was reported; the last one announces the give-up
    const lines = errorLines()
    expect(lines).toHaveLength(4)
    for (const [index, line] of lines.entries()) {
      expect(line).toMatch(LOG_LINE)
      expect(line).toContain(`(attempt ${index + 1}/4)`)
    }
    expect(lines[0]).toMatch(/retrying in 5s$/)
    expect(lines[1]).toMatch(/retrying in 20s$/)
    expect(lines[2]).toMatch(/retrying in 60s$/)
    expect(lines[3]).toMatch(/giving up until the next credential change$/)
    expect(vi.getTimerCount()).toBe(0)
    expect(h.reload).not.toHaveBeenCalled()

    // exhausted: no further attempts on their own
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS * 5)
    expect(mockListModels).toHaveBeenCalledTimes(4)

    // the plugin keeps working without a runtime inventory: the transform leaves
    // the provider untouched
    expect(publishedModels(h, ["existing-model"])).toEqual(["existing-model"])

    // the next credential change starts a new chain
    mockListModels.mockResolvedValue([runtime("model-a")])
    h.events.push(credentialUpdatedEvent())
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(5)
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("a burst of login events yields one probe per location", async () => {
    // two locations, each with its own setup and its own mock context. The
    // credential events of one login arrive in quick succession; while the
    // first probe is in flight the rest coalesce onto it. Contexts are driven
    // one after the other so their dynamic SDK imports never overlap.
    const first = deferredModels()
    const second = deferredModels()
    mockListModels.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)

    const h1 = makeMockContext()
    const cleanup1 = await runSetup(h1)
    await flush()
    const h2 = makeMockContext()
    const cleanup2 = await runSetup(h2)
    await flush()
    expect(h1.directory).not.toBe(h2.directory)
    expect(mockListModels).not.toHaveBeenCalled() // disconnected at setup

    const loginBurst = () => [kiroEvent(), credentialUpdatedEvent(), credentialSwitchedEvent("kiro", "credential-1")]
    const probesFor = (h: Harness) => mockListModels.mock.calls.filter(([arg]) => arg?.cwd === h.directory).length

    // login on location 1
    h1.active.mockResolvedValue({ integrationID: "kiro" })
    for (const event of loginBurst()) h1.events.push(event)
    await flush()
    expect(probesFor(h1)).toBe(1)
    expect(probesFor(h2)).toBe(0)

    // login on location 2
    h2.active.mockResolvedValue({ integrationID: "kiro" })
    for (const event of loginBurst()) h2.events.push(event)
    await flush()
    expect(probesFor(h1)).toBe(1)
    expect(probesFor(h2)).toBe(1)
    expect(mockListModels).toHaveBeenCalledTimes(2)

    // each location publishes its own answer exactly once
    first.resolve([runtime("model-a")])
    second.resolve([runtime("model-b")])
    await flush()
    expect(h1.reload).toHaveBeenCalledTimes(1)
    expect(h2.reload).toHaveBeenCalledTimes(1)
    expect(publishedModels(h1, ["model-a", "model-b"])).toEqual(["model-a"])
    expect(publishedModels(h2, ["model-a", "model-b"])).toEqual(["model-b"])

    await cleanup1()
    await cleanup2()
  })
})

// ---------------------------------------------------------------------------
// AISDK hook ownership + aggregated idempotent cleanup
// ---------------------------------------------------------------------------

describe("aisdk sdk hook + lifecycle", () => {
  test("hook is registered providerID-scoped and overwrites a pre-populated event.sdk with the owned instance", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    expect(h.getSdkHookName()).toBe("sdk")
    // ModelHookOptions scoping: the hook only fires for the kiro provider
    expect(h.getSdkHookOptions()).toEqual({ providerID: "kiro" })

    const unowned = { languageModel: vi.fn() } // provider pre-populated by the host
    const event = {
      model: { modelID: "claude-sonnet-4.6" },
      package: "kiro-acp-ai-provider",
      options: { cwd: h.directory, agent: "opencode" },
      sdk: unowned as unknown,
    }
    await h.sdkHook(event)

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    // the factory receives the allowlist-sanitized settings plus the
    // process-constant clientInfo — never the raw event options
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: h.directory,
        agent: "opencode",
        clientInfo: { name: "opencode-kiro", version: expect.any(String) },
      }),
    )
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ fetch: expect.anything() }),
    )
    expect(event.sdk).toBe(sdkInstances[0])
    expect(event.sdk).not.toBe(unowned)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (event.sdk as any).languageModel).toBe("function")

    await cleanup()
  })

  test("non-kiro packages are left alone", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const foreign = { languageModel: vi.fn() }
    const event = { model: {}, package: "some-other-provider", options: {}, sdk: foreign as unknown }
    await h.sdkHook(event)

    expect(mockCreateKiroAcp).not.toHaveBeenCalled()
    expect(event.sdk).toBe(foreign)

    await cleanup()
  })

  test("owned instances are reused per sanitized settings key and shut down exactly once on cleanup", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // realistic production shape: the host's prepareOptions unconditionally
    // injects an `options.fetch` function plus name/headers/body extras. The
    // allowlist key drops them, so events sharing the same allowlisted subset
    // share one owned instance.
    const base = { cwd: "/a", agent: "opencode", trustAllTools: true }
    const eventA1 = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, fetch: () => {}, name: "kiro", headers: { "x-a": "1" }, body: { a: 1 } },
      sdk: undefined as unknown,
    }
    const eventA2 = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, fetch: () => {}, name: "kiro", headers: { "x-a": "2" }, body: { a: 2 } },
      sdk: undefined as unknown,
    }
    const eventB = {
      model: {},
      package: "kiro-acp-ai-provider",
      options: { ...base, cwd: "/b", fetch: () => {} },
      sdk: undefined as unknown,
    }
    await h.sdkHook(eventA1)
    await h.sdkHook(eventA2)
    await h.sdkHook(eventB)

    // sanitized-settings reuse: same allowlisted subset -> same owned
    // instance despite differing fetch identities/unknown extras
    expect(eventA2.sdk).toBe(eventA1.sdk)
    expect(eventB.sdk).not.toBe(eventA1.sdk) // different cwd -> different instance
    expect(sdkInstances).toHaveLength(2)

    await cleanup()
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)

    await cleanup() // second cleanup must not shut anything down again
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)
  })

  test("cleanup is idempotent and complete across auth, discovery and aisdk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue({ installed: true, authenticated: false })

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // put a login poll in flight so cleanup has timers + a child to release;
    // no catch handler is attached here — the production callback guard
    // absorbs the disposal rejection (vitest would fail the run on an
    // unhandled rejection)
    const authorization = await authorize({})
    expect(authorization.mode).toBe("auto")
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    const first = cleanup()
    const second = cleanup()
    await Promise.all([first, second])

    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.provider).toHaveBeenCalledTimes(1)
    // two aisdk registrations (sdk + language), each disposed exactly once
    // through the shared knob
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(2)
    expect(h.hooks.get("sdk")!.dispose).toHaveBeenCalledTimes(1)
    expect(h.hooks.get("language")!.dispose).toHaveBeenCalledTimes(1)
    expect(h.events.returned).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // a later third call is equally safe and disposes nothing again
    await cleanup()
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).toHaveBeenCalledTimes(2)
  })

  test("a failing disposer does not block the others; failures aggregate", async () => {
    const h = makeMockContext()
    const hookError = new Error("hook dispose exploded")
    h.disposeSpies.hook.mockRejectedValue(hookError)

    const cleanup = await runSetup(h)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failure: any = await (async () => cleanup())().then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toContain(hookError)
    // every other resource was still disposed
    expect(h.disposeSpies.provider).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.events.returned).toHaveBeenCalledTimes(1)
  })

  test("setup failure runs partial cleanup over earlier registrations and rethrows", async () => {
    const h = makeMockContext()
    const bootError = new Error("provider transform registration failed")
    h.raw.provider.transform.mockRejectedValue(bootError)

    await expect(serverPlugin.setup(h.context)).rejects.toBe(bootError)

    // auth registered before the discovery failure -> its disposer ran
    expect(h.disposeSpies.integration).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.hook).not.toHaveBeenCalled()
  })

  // effort-key regression test: variant settings -> host `withVariant` overlay
  // -> aisdk hook `event.options` carries the SDK's `effort` key (never
  // `reasoningEffort`). On the factory side the allowlist strips `effort` from
  // the `createKiroAcp` settings (one shared provider across efforts); the
  // per-request carrier is the `language` hook's `languageModel(id, { effort })`
  // override, covered in the language-hook describe block below.
  test("the effort variant reaches event.options but is stripped from createKiroAcp settings", async () => {
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["high"], baselineEffort: undefined }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "with-efforts", modelID: "with-efforts" }])
    h.providerTransform(provider.editor)

    const record = provider.providers.get("kiro")!
    const variant = record.models.get("with-efforts")!.variants[0]
    expect(variant).toEqual({ id: "high", settings: { effort: "high" } })

    // simulate the host resolving the effort variant: provider settings
    // overlaid with the variant settings become the sdk event options
    const options = { ...record.provider.settings, ...variant.settings }
    const event = { model: { modelID: "with-efforts" }, package: "kiro-acp-ai-provider", options, sdk: undefined as unknown }
    await h.sdkHook(event)

    expect(options.effort).toBe("high") // the host overlay contract is intact
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(expect.objectContaining({ cwd: h.directory }))
    // allowlist strips effort/efforts from the factory settings...
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ effort: expect.anything() }),
    )
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ efforts: expect.anything() }),
    )
    // ...and the legacy key never appears anywhere
    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    )
    // the owned provider serves the model the request path resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((event.sdk as any).languageModel("with-efforts")).toBeDefined()

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// aisdk language hook + allowlist sanitization + clientInfo
// ---------------------------------------------------------------------------

describe("aisdk language hook, settings allowlist and clientInfo", () => {
  /** the version the CLIENT_INFO constant must carry — read from the real
   * package.json so the assertion survives version bumps (no hardcoded literal) */
  const pkgVersion = (
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version: string }
  ).version

  /** production-realistic sdk-hook event (fetch-bearing) */
  function sdkEvent(options: Record<string, unknown>) {
    return { model: {}, package: "kiro-acp-ai-provider", options, sdk: undefined as unknown }
  }

  test("language hook is registered providerID-scoped and disposed on cleanup exactly once", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const registration = h.hooks.get("language")
    expect(registration).toBeDefined()
    // ModelHookOptions scoping: fires only for the kiro provider
    expect(registration!.options).toEqual({ providerID: "kiro" })
    expect(registration!.dispose).not.toHaveBeenCalled()

    await cleanup()
    expect(registration!.dispose).toHaveBeenCalledTimes(1)

    await cleanup() // idempotent: no second disposal
    expect(registration!.dispose).toHaveBeenCalledTimes(1)
  })

  test("override path: variant effort flows via languageModel(id, { effort })", async () => {
    // end-to-end: catalog variant -> host `withVariant` overlay -> language-hook
    // `event.options.effort` -> KiroACPModelOverrides
    const h = makeMockContext()
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([
      runtime("with-efforts", { runtimeEfforts: ["high"], baselineEffort: undefined }),
    ])
    const cleanup = await runSetup(h)
    await flush()

    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "with-efforts", modelID: "with-efforts" }])
    h.providerTransform(provider.editor)
    const record = provider.providers.get("kiro")!
    const variant = record.models.get("with-efforts")!.variants[0]
    expect(variant).toEqual({ id: "high", settings: { effort: "high" } })

    // host overlay + production fetch injection shape the options
    const options = { ...record.provider.settings, ...variant.settings, fetch: () => {} }
    const event = sdkEvent(options)
    ;(event as { model: unknown }).model = { modelID: "with-efforts" }
    await h.sdkHook(event)
    const owned = sdkInstances[0]
    expect(event.sdk).toBe(owned)

    // the host calls the language hook after the sdk hook with the resolved
    // event.sdk
    const languageEvent = {
      model: { modelID: "with-efforts" },
      sdk: event.sdk,
      options,
      language: undefined as unknown,
    }
    await h.languageHook(languageEvent)

    expect(owned.languageModel).toHaveBeenCalledTimes(1)
    expect(owned.languageModel).toHaveBeenCalledWith("with-efforts", { effort: "high" })
    expect(languageEvent.language).toBe(owned.languageModel.mock.results[0]!.value)

    await cleanup()
  })

  test("no effort -> undefined overrides", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const sdk = { languageModel: vi.fn(() => ({ sentinel: true })) }
    const languageEvent = {
      model: { modelID: "claude-sonnet-4.6" },
      sdk,
      options: { cwd: "/a", agent: "opencode" },
      language: undefined as unknown,
    }
    await h.languageHook(languageEvent)

    // no invented effort and no extra fallback: absent effort passes
    // undefined overrides so the SDK's own settings precedence applies
    expect(sdk.languageModel).toHaveBeenCalledTimes(1)
    expect(sdk.languageModel).toHaveBeenCalledWith("claude-sonnet-4.6", undefined)
    expect(languageEvent.language).toBe(sdk.languageModel.mock.results[0]!.value)

    await cleanup()
  })

  test("non-string effort is ignored", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    const sdk = { languageModel: vi.fn(() => ({ sentinel: true })) }
    for (const effort of [42, {}]) {
      await h.languageHook({
        model: { modelID: "claude-sonnet-4.6" },
        sdk,
        options: { cwd: "/a", effort },
        language: undefined as unknown,
      })
    }

    // string guard: anything but a string effort yields undefined overrides
    expect(sdk.languageModel).toHaveBeenCalledTimes(2)
    expect(sdk.languageModel).toHaveBeenNthCalledWith(1, "claude-sonnet-4.6", undefined)
    expect(sdk.languageModel).toHaveBeenNthCalledWith(2, "claude-sonnet-4.6", undefined)

    await cleanup()
  })

  test("factory receives only allowlisted keys + clientInfo", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // production-realistic options: catalog settings + variant effort + the
    // host-injected fetch/name/headers/body extras + a future unknown key
    await h.sdkHook(
      sdkEvent({
        cwd: "/w",
        agent: "opencode",
        trustAllTools: true,
        mcpTimeout: 45,
        contextWindows: { "claude-sonnet-4.6": 200_000 },
        effort: "high",
        fetch: () => {},
        name: "kiro",
        headers: { "x-h": "1" },
        body: { b: 1 },
        futureUnknownKey: "x",
      }),
    )

    // exact key-set assertion — the strongest form of the allowlist contract:
    // key set = (passed keys ∩ allowlist) ∪ {clientInfo}; no fetch, effort,
    // efforts, name, headers, body or unknown keys may reach the factory
    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    const arg = mockCreateKiroAcp.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(arg).sort()).toEqual([
      "agent",
      "clientInfo",
      "contextWindows",
      "cwd",
      "mcpTimeout",
      "trustAllTools",
    ])

    await cleanup()
  })

  test("clientInfo is process-constant and matches package.json", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // two distinct configs -> two factory calls, same constant clientInfo
    await h.sdkHook(sdkEvent({ cwd: "/one", fetch: () => {} }))
    await h.sdkHook(sdkEvent({ cwd: "/two", fetch: () => {} }))

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(2)
    const expected = { name: "opencode-kiro", version: pkgVersion }
    const first = (mockCreateKiroAcp.mock.calls[0]![0] as Record<string, unknown>).clientInfo
    const second = (mockCreateKiroAcp.mock.calls[1]![0] as Record<string, unknown>).clientInfo
    expect(first).toEqual(expected) // no timestamps, no per-request fields
    expect(second).toEqual(expected)

    await cleanup()
  })

  test("provider is shared across efforts; per-request override diverges", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // core invariant: effort differences must not split the provider — one
    // factory call — while each request still carries its own effort via the
    // language-hook override
    const base = { cwd: "/shared", agent: "opencode", trustAllTools: true }
    const eventA = sdkEvent({ ...base, effort: "high", fetch: () => {} })
    const eventB = sdkEvent({ ...base, effort: "low", fetch: () => {} })
    await h.sdkHook(eventA)
    await h.sdkHook(eventB)

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    expect(eventB.sdk).toBe(eventA.sdk)
    const owned = sdkInstances[0]

    await h.languageHook({ model: { modelID: "m" }, sdk: eventA.sdk, options: eventA.options, language: undefined })
    await h.languageHook({ model: { modelID: "m" }, sdk: eventB.sdk, options: eventB.options, language: undefined })

    expect(owned.languageModel).toHaveBeenNthCalledWith(1, "m", { effort: "high" })
    expect(owned.languageModel).toHaveBeenNthCalledWith(2, "m", { effort: "low" })

    await cleanup()
  })

  test("distinct allowlisted config -> distinct provider", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // the key must still discriminate real config differences
    const base = { cwd: "/same", agent: "opencode" }
    await h.sdkHook(sdkEvent({ ...base, contextWindows: { m: 100_000 }, fetch: () => {} }))
    await h.sdkHook(sdkEvent({ ...base, contextWindows: { m: 200_000 }, fetch: () => {} }))

    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(2)
    expect(sdkInstances).toHaveLength(2)

    await cleanup()
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)

    await cleanup() // idempotent: nothing shuts down twice
    for (const instance of sdkInstances) expect(instance.shutdown).toHaveBeenCalledTimes(1)
  })

  test("reasoningEffort never appears on the factory or the override path", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // effort-bearing flow: sdk hook + language hook (the effort key is the
    // SDK's `effort`; the legacy name must never resurface)
    const event = sdkEvent({ cwd: "/g", effort: "high", fetch: () => {} })
    await h.sdkHook(event)
    const owned = sdkInstances[0]
    await h.languageHook({ model: { modelID: "m" }, sdk: event.sdk, options: event.options, language: undefined })

    expect(mockCreateKiroAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: expect.anything() }),
    )
    for (const call of owned.languageModel.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("reasoningEffort")
    }
    // confirms the flow actually ran
    expect(owned.languageModel).toHaveBeenCalledWith("m", { effort: "high" })

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// plugin options `agent` / `mcpTimeout` / `discover`
// ---------------------------------------------------------------------------

describe("plugin options", () => {
  /** connected setup + one runtime model + a rich provider editor -> provider record */
  async function setupAndTransform(h: Harness) {
    h.active.mockResolvedValue({ integrationID: "kiro" })
    mockListModels.mockResolvedValue([runtime("claude-sonnet-4.6")])
    const cleanup = await runSetup(h)
    await flush()
    const provider = makeProviderEditor()
    seedRichKiro(provider, [{ key: "sonnet", modelID: "claude-sonnet-4.6" }])
    h.providerTransform(provider.editor)
    const record = provider.providers.get("kiro")
    expect(record).toBeDefined()
    return { cleanup, record: record! }
  }

  test("options absent → defaults applied", async () => {
    const h = makeMockContext() // no options key at all: exercises the ?? {} guard
    expect("options" in h.raw).toBe(false)

    const { cleanup, record } = await setupAndTransform(h)

    // setup kick-off fired with the default `discover: true`
    expect(mockListModels).toHaveBeenCalledTimes(1)
    // catalog settings carry the documented defaults
    expect(record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    expect(record.provider.settings!.trustAllTools).toBe(true)

    await cleanup()
  })

  test("custom agent/mcpTimeout flow to createKiroAcp", async () => {
    const h = makeMockContext({ options: { agent: "custom", mcpTimeout: 90 } })
    const { cleanup, record } = await setupAndTransform(h)

    // catalog side
    expect(record.provider.settings).toMatchObject({ agent: "custom", mcpTimeout: 90 })
    expect(record.provider.settings!.trustAllTools).toBe(true) // never an option

    // host side: provider.settings → prepareOptions spread (+ injected fetch)
    // → sdk hook → allowlist (both keys allowlisted) → createKiroAcp
    const options = { ...record.provider.settings, fetch: () => {} }
    await h.sdkHook({ model: { modelID: "claude-sonnet-4.6" }, package: "kiro-acp-ai-provider", options, sdk: undefined })
    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "custom", mcpTimeout: 90, cwd: h.directory }),
    )

    await cleanup()
  })

  test("type-invalid options fall back to defaults", async () => {
    // wrong types for every key: parsing is defensive, setup must not throw
    const h = makeMockContext({ options: { agent: 7, mcpTimeout: "45", discover: "yes" } })
    const { cleanup, record } = await setupAndTransform(h)

    expect(mockListModels).toHaveBeenCalledTimes(1) // discover fell back to true
    expect(record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    await cleanup()

    // edge values that pass a naive typeof: empty agent and a non-finite timeout
    const h2 = makeMockContext({ options: { agent: "", mcpTimeout: Number.NaN } })
    const second = await setupAndTransform(h2)
    expect(second.record.provider.settings).toMatchObject({ agent: "opencode", mcpTimeout: 45 })
    await second.cleanup()

    // non-positive timeouts are finite numbers but not a usable duration
    for (const mcpTimeout of [0, -1]) {
      const h3 = makeMockContext({ options: { mcpTimeout } })
      const third = await setupAndTransform(h3)
      expect(third.record.provider.settings).toMatchObject({ mcpTimeout: 45 })
      await third.cleanup()
    }
  })

  test("discover:false gates setup kick-off only", async () => {
    const h = makeMockContext({ options: { discover: false } })
    h.active.mockResolvedValue({ integrationID: "kiro" }) // connected at setup
    mockListModels.mockResolvedValue([runtime("model-a")])

    const cleanup = await runSetup(h)
    await flush()

    // connected, yet no setup-time discovery
    expect(mockListModels).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()

    // the event-driven path is untouched: a credential event still discovers
    h.events.push(credentialUpdatedEvent())
    await flush()
    expect(mockListModels).toHaveBeenCalledTimes(1)
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(h.reload).toHaveBeenCalledTimes(1)

    await cleanup()
  })

  test("no cwd option surface", async () => {
    // a user-supplied cwd is an unknown key: ignored silently, never plumbed
    const h = makeMockContext({ options: { cwd: "/elsewhere" } })
    const { cleanup, record } = await setupAndTransform(h)

    // discovery and catalog settings both derive cwd from the location
    expect(mockListModels).toHaveBeenCalledWith({ cwd: h.directory })
    expect(record.provider.settings!.cwd).toBe(h.directory)
    expect(JSON.stringify(record.provider.settings)).not.toContain("/elsewhere")

    // and the factory never sees it either
    const options = { ...record.provider.settings, fetch: () => {} }
    await h.sdkHook({ model: { modelID: "claude-sonnet-4.6" }, package: "kiro-acp-ai-provider", options, sdk: undefined })
    expect(mockCreateKiroAcp).toHaveBeenCalledWith(expect.objectContaining({ cwd: h.directory }))
    expect(JSON.stringify(mockCreateKiroAcp.mock.calls)).not.toContain("/elsewhere")

    await cleanup()
  })

  /** run the host-side flow: provider settings (+ injected fetch) -> sdk hook -> factory settings */
  async function factorySettings(h: Harness, providerSettings: Record<string, unknown>) {
    mockCreateKiroAcp.mockClear() // the factory mock is shared across setups within one test
    const options = { ...providerSettings, fetch: () => {} }
    await h.sdkHook({ model: { modelID: "claude-sonnet-4.6" }, package: "kiro-acp-ai-provider", options, sdk: undefined })
    expect(mockCreateKiroAcp).toHaveBeenCalledTimes(1)
    return mockCreateKiroAcp.mock.calls[0]![0] as Record<string, unknown>
  }

  test("stall option flows through the provider settings to createKiroAcp", async () => {
    const stall = { afterMs: 5_000, live: "off" }
    const h = makeMockContext({ options: { stall } })
    const { cleanup, record } = await setupAndTransform(h)

    // catalog side: the validated object is emitted as-is
    expect(record.provider.settings!.stall).toEqual(stall)

    // host side: the allowlist lets it through to the factory unchanged
    const settings = await factorySettings(h, record.provider.settings!)
    expect(settings.stall).toEqual(stall)
    // still one shared provider per config: the option does not leak elsewhere
    expect(settings).toEqual(expect.objectContaining({ agent: "opencode", mcpTimeout: 45, cwd: h.directory }))

    await cleanup()
  })

  test("invalid stall shapes are dropped member by member without throwing", async () => {
    // not an object at all: the key is absent everywhere
    for (const stall of ["soon", 30_000, true, null, [5_000]]) {
      const h = makeMockContext({ options: { stall } })
      const { cleanup, record } = await setupAndTransform(h)
      expect("stall" in record.provider.settings!).toBe(false)
      const settings = await factorySettings(h, record.provider.settings!)
      expect("stall" in settings).toBe(false)
      await cleanup()
    }

    // every member invalid: nothing valid remains, so the key is absent
    for (const stall of [{ afterMs: -1, live: "loud" }, { afterMs: "30s" }, { afterMs: Number.NaN }, { live: "on" }, {}]) {
      const h = makeMockContext({ options: { stall } })
      const { cleanup, record } = await setupAndTransform(h)
      expect("stall" in record.provider.settings!).toBe(false)
      await cleanup()
    }

    // partially valid: the valid member survives alone
    const h1 = makeMockContext({ options: { stall: { afterMs: -1, live: "reasoning" } } })
    const first = await setupAndTransform(h1)
    expect(first.record.provider.settings!.stall).toEqual({ live: "reasoning" })
    await first.cleanup()

    const h2 = makeMockContext({ options: { stall: { afterMs: 45_000, live: "loud", unknown: 1 } } })
    const second = await setupAndTransform(h2)
    expect(second.record.provider.settings!.stall).toEqual({ afterMs: 45_000 })
    await second.cleanup()

    // zero is a valid threshold (it disables the watchdog), unlike a negative value
    const h3 = makeMockContext({ options: { stall: { afterMs: 0 } } })
    const third = await setupAndTransform(h3)
    expect(third.record.provider.settings!.stall).toEqual({ afterMs: 0 })
    await third.cleanup()
  })

  test("omitted stall option leaves the key out of the provider and factory settings", async () => {
    const h = makeMockContext({ options: { agent: "custom" } })
    const { cleanup, record } = await setupAndTransform(h)

    // no default is invented: the SDK's own stall defaults apply when the key is absent
    expect("stall" in record.provider.settings!).toBe(false)
    const settings = await factorySettings(h, record.provider.settings!)
    expect("stall" in settings).toBe(false)
    expect(Object.keys(settings).sort()).toEqual(["agent", "clientInfo", "contextWindows", "cwd", "mcpTimeout", "trustAllTools"])

    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// async auth probe + login-callback guard
// ---------------------------------------------------------------------------

describe("auth: async probe and login-callback guard", () => {
  const UNAUTHENTICATED: AuthStatus = { installed: true, authenticated: false }
  const AUTHENTICATED: AuthStatus = { installed: true, authenticated: true }
  const TIMEOUT_GUIDANCE =
    /^Kiro authentication timed out\. Run `kiro-cli login` manually, then re-run `opencode auth login`\.$/

  /** manually-controlled probe promise (for the mid-probe disposal tests) */
  function deferredStatus() {
    let resolve!: (status: AuthStatus) => void
    const promise = new Promise<AuthStatus>((r) => (resolve = r))
    return { promise, resolve }
  }

  test("login succeeds via async probe without blocking semantics", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    // authorize entry + 1st tick unauthenticated, then authenticated
    mockVerifyAuthAsync
      .mockResolvedValueOnce(UNAUTHENTICATED)
      .mockResolvedValueOnce(UNAUTHENTICATED)
      .mockResolvedValue(AUTHENTICATED)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const credential = expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    await vi.advanceTimersByTimeAsync(2_000) // 1st poll: still unauthenticated
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000) // 2nd poll: authenticated
    await credential // `expires: 0` marker, no synthetic expiry
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // every probe call — entry and ticks — was the async variant (returned a
    // Promise the flow awaited), never a sync spawn
    for (const result of mockVerifyAuthAsync.mock.results) {
      expect(result.value).toBeInstanceOf(Promise)
    }

    await cleanup()
  })

  test("abandoned login raises no unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED) // never logs in

    // in addition to vitest's own failure-on-unhandled-rejection, a scoped
    // listener captures anything that leaks during this test
    const captured: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      captured.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const h = makeMockContext()
      const { cleanup, authorize } = await setupWithAuthorize(h)

      // no `.catch` attached by this test before the timeout fires
      const authorization = await authorize({})

      await vi.advanceTimersByTimeAsync(121_000) // > 120s poll budget → rejects
      await flush() // let Node run its unhandled-rejection sweep
      expect(captured).toEqual([])
      expect(vi.getTimerCount()).toBe(0)

      // the original promise was returned, so a late consumer still observes
      // the rejection (a swallowed promise would resolve)
      await expect(authorization.callback).rejects.toThrow(/`kiro-cli login`/)

      await cleanup()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("returned callback is the original (rejection observable)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    // a consumer attached up-front: `callback.catch(() => {})` as the returned
    // value would resolve to undefined here instead of rejecting
    const rejection = expect(authorization.callback).rejects.toThrow(TIMEOUT_GUIDANCE)

    await vi.advanceTimersByTimeAsync(121_000)

    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("disposal mid-probe: no re-arm, no double-settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const probe = deferredStatus()
    // authorize entry resolves immediately (unauthenticated → spawn + poll);
    // the first tick gets the manually-controlled pending probe
    mockVerifyAuthAsync.mockResolvedValueOnce(UNAUTHENTICATED).mockImplementation(() => probe.promise)
    const child = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValue(child as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    const rejection = expect(authorization.callback).rejects.toThrow(/cancelled/)

    await vi.advanceTimersByTimeAsync(2_000) // tick fires and is now in flight
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0) // timer cleared at tick start, not yet re-armed

    await cleanup() // disposal while the probe is pending → cancel
    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)

    // the late probe result arrives unauthenticated with budget left — exactly
    // the input that would make an unguarded tick re-arm the 2s timer after
    // cleanup (leaked timer) and later time out into a second settle. The
    // guarded tick must bail: cancelPoll was disarmed by the disposal.
    probe.resolve(UNAUTHENTICATED)
    await flush()
    expect(vi.getTimerCount()).toBe(0)

    // no leaked timer means no further probes ever run
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(child.kill).toHaveBeenCalledTimes(1)
    // and the callback stays settled as cancelled (never re-settled as timeout)
    await expect(authorization.callback).rejects.toThrow(/cancelled/)
  })

  test("probe cadence: memo-friendly 2s ticks up to 120s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(UNAUTHENTICATED)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const authorization = await authorize({})
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(1) // authorize entry probe
    const rejection = expect(authorization.callback).rejects.toThrow(TIMEOUT_GUIDANCE)

    // cadence constants (auth.ts POLL_INTERVAL_MS / MAX_WAIT_MS): one probe per
    // 2s tick, so the SDK's 5s memo absorbs roughly two of every three
    await vi.advanceTimersByTimeAsync(1_999)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(1) // nothing before 2s
    await vi.advanceTimersByTimeAsync(1)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2) // 1st tick at exactly 2s
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3) // 2nd tick at 4s

    // ticks at 6s..120s: the 60th tick (t=120s) observes elapsed >= 120s → timeout
    await vi.advanceTimersByTimeAsync(116_000)
    await rejection
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(61) // 1 entry + 60 ticks
    expect(vi.getTimerCount()).toBe(0)

    // no probe past the budget
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(61)

    await cleanup()
  })

  // connect → abandon → reconnect must not leave a `kiro-cli login` child alive
  // with no owner. `state.auth` is one shared AuthResources, so a second
  // authorize() that overwrote `child`/`cancelPoll` without releasing the first
  // attempt would orphan its process. Without the supersede step the first
  // child is never killed (its poll now owns the second child), so
  // `firstChild.kill` toHaveBeenCalledTimes(1) is the discriminating assertion.
  test("second authorize() while pending supersedes the first: one child alive at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    mockVerifyAuthAsync.mockImplementation(async () => ({ installed: true, authenticated }))
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // attempt 1: spawn + poll, then the user abandons the browser flow
    const first = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const firstRejection = expect(first.callback).rejects.toThrow(/superseded/)
    await vi.advanceTimersByTimeAsync(2_000) // 1st tick: still unauthenticated
    expect(firstChild.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    // attempt 2 while attempt 1 is pending
    const second = await authorize({})
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    // previous child killed exactly once, before the new child was spawned
    // (never two `kiro-cli login` processes alive at the same time)
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[1])
    // previous callback rejects with the supersession reason (not timeout, not cancelled)
    await firstRejection
    // only attempt 2's poll timer remains; attempt 1's was cleared, not orphaned
    expect(vi.getTimerCount()).toBe(1)
    expect(secondChild.kill).not.toHaveBeenCalled()

    // attempt 2 proceeds and resolves normally
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 2nd tick: authenticated
    await credential
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1) // not killed again by attempt 2's release
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })

  // Companion to the tick's ownership guard: attempt 1's probe is in flight
  // when attempt 2 supersedes it. The late probe result must not let attempt
  // 1's tick act on the shared fields — an `=== undefined` guard would pass
  // here (cancelPoll now holds attempt 2's canceller) and the stale tick would
  // kill attempt 2's child and disarm attempt 2's poll.
  test("supersession mid-probe: the stale tick neither re-arms nor touches the successor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const probe = deferredStatus()
    mockVerifyAuthAsync
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 1 entry
      .mockImplementationOnce(() => probe.promise) // attempt 1, 1st tick (held)
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 2 entry
      .mockResolvedValueOnce(UNAUTHENTICATED) // attempt 2, 1st tick
      .mockResolvedValue(AUTHENTICATED) // attempt 2, 2nd tick
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    const first = await authorize({})
    const firstRejection = expect(first.callback).rejects.toThrow(/superseded/)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 1 tick fires, probe in flight
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    const second = await authorize({})
    await firstRejection
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1) // attempt 2's timer only
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)

    // the late result for attempt 1 arrives authenticated — the input that
    // would make a stale, unguarded tick release attempt 2's child
    probe.resolve(AUTHENTICATED)
    await flush()
    expect(secondChild.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1) // attempt 2's timer untouched, no extra re-arm

    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000) // attempt 2, 2nd tick: authenticated
    await credential
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(5)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  // The supersede check → spawn → cancelPoll claim in authorize() must be one
  // synchronous segment: an await between the check and the spawn lets two
  // authorize() calls resuming in the same microtask window both observe
  // `cancelPoll === undefined` and both spawn, leaving the first child orphaned
  // (`firstChild.kill` would then never be called).
  //
  // Harness note: the two calls are not started in the same tick. vitest's
  // manual mocks do not survive two concurrent dynamic imports of one module
  // (the second `import("kiro-acp-ai-provider")` would resolve to the real
  // SDK and spawn kiro-cli), so each call is parked at its entry probe first
  // and both probes are then released in one synchronous segment — that puts
  // both continuations in the same microtask window at the supersede check,
  // which is exactly the race.
  test("two authorize() calls resuming in the same microtask window: exactly one child alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    const probeA = deferredStatus()
    const probeB = deferredStatus()
    mockVerifyAuthAsync
      .mockImplementationOnce(() => probeA.promise) // attempt 1 entry (held)
      .mockImplementationOnce(() => probeB.promise) // attempt 2 entry (held)
      .mockImplementation(async () => ({ installed: true, authenticated })) // ticks
    const firstChild = makeFakeChild()
    const secondChild = makeFakeChild()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockExecFile.mockReturnValueOnce(firstChild as any).mockReturnValueOnce(secondChild as any)

    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)

    // park both attempts at their entry probes (imports done, nothing spawned)
    const a = authorize({})
    await flush()
    const b = authorize({})
    await flush()
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(mockExecFile).not.toHaveBeenCalled()

    // release both in one synchronous segment: both continuations now reach
    // the supersede check in the same microtask window
    probeA.resolve(UNAUTHENTICATED)
    probeB.resolve(UNAUTHENTICATED)
    const [first, second] = await Promise.all([a, b])
    expect(mockExecFile).toHaveBeenCalledTimes(2)

    // exactly one child alive: the first was killed exactly once, before the
    // second was spawned; the second is untouched
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[1])
    expect(secondChild.kill).not.toHaveBeenCalled()
    // the first callback was superseded (not timeout, not cancelled); only the
    // second attempt's poll timer remains
    await expect(first.callback).rejects.toThrow(/superseded/)
    expect(vi.getTimerCount()).toBe(1)

    // the second attempt proceeds and resolves on an authenticated probe
    const credential = expect(second.callback).resolves.toEqual(EXPECTED_CREDENTIAL)
    await vi.advanceTimersByTimeAsync(2_000) // 1st tick: unauthenticated
    expect(secondChild.kill).not.toHaveBeenCalled()
    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000) // 2nd tick: authenticated
    await credential
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).toHaveBeenCalledTimes(1) // not killed again
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
    expect(firstChild.kill).toHaveBeenCalledTimes(1)
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// logout detection: the hybrid detector behind the `context` session hook
// ---------------------------------------------------------------------------

describe("logout detection: stage machine over fresh probes", () => {
  const AUTHENTICATED: AuthStatus = { installed: true, authenticated: true }
  const LOGGED_OUT: AuthStatus = { installed: true, authenticated: false }
  const INCONCLUSIVE: AuthStatus = { installed: true, authenticated: false, inconclusive: true }
  const NOT_INSTALLED: AuthStatus = { installed: false, authenticated: false }

  let errorSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    errorSpy?.mockRestore()
    errorSpy = undefined
  })

  /**
   * Detector over a hand-controlled probe: every probe call parks a deferred
   * result so tests decide when and how each probe answers. Fake timers cover
   * setTimeout/clearTimeout/Date so the memo and the follow-up are exact.
   */
  function makeDetector() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const state = createLogoutState()
    const pending: Array<{ resolve: (status: AuthStatus) => void; reject: (error: unknown) => void }> = []
    const probe = vi.fn(
      () =>
        new Promise<AuthStatus>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const reload = vi.fn(async () => {})
    const detector = createLogoutDetector(state, { probe, reload })
    /** answer the oldest unanswered probe and let the result settle */
    const answer = async (status: AuthStatus): Promise<void> => {
      const next = pending.shift()
      if (next === undefined) throw new Error("no probe in flight to answer")
      next.resolve(status)
      await flush()
    }
    /** fail the oldest unanswered probe and let the failure settle */
    const fail = async (error: unknown): Promise<void> => {
      const next = pending.shift()
      if (next === undefined) throw new Error("no probe in flight to fail")
      next.reject(error)
      await flush()
    }
    return { state, probe, reload, detector, answer, fail, inflight: () => pending.length }
  }

  /** drive the detector from `none` to `suspected` with one negative step probe */
  async function reachSuspected(d: ReturnType<typeof makeDetector>): Promise<void> {
    d.detector.step()
    await d.answer(LOGGED_OUT)
    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)
  }

  /** drive the detector from `none` to `confirmed` via the negative follow-up */
  async function reachConfirmed(d: ReturnType<typeof makeDetector>): Promise<void> {
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(LOGGED_OUT)
    expect(d.state.stage).toBe("confirmed")
    expect(d.reload).toHaveBeenCalledTimes(2)
  }

  test("constants carry the documented values", () => {
    expect(LOGOUT_MEMO_MS).toBe(60_000)
    expect(LOGOUT_FOLLOW_UP_MS).toBe(6_000)
  })

  test("step() returns synchronously and never awaits the probe", () => {
    const d = makeDetector()

    const returned = d.detector.step() as unknown

    expect(returned).toBeUndefined()
    expect(d.probe).toHaveBeenCalledTimes(1)
    expect(d.inflight()).toBe(1) // still unanswered, and nothing waited for it
  })

  test("an authenticated result is memoized for exactly LOGOUT_MEMO_MS", async () => {
    const d = makeDetector()
    d.detector.step()
    await d.answer(AUTHENTICATED)
    expect(d.reload).not.toHaveBeenCalled()
    expect(d.state.stage).toBe("none")

    // inside the memo: steps start nothing
    d.detector.step()
    await vi.advanceTimersByTimeAsync(LOGOUT_MEMO_MS - 1)
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(1)

    // at the boundary: the next step probes again
    await vi.advanceTimersByTimeAsync(1)
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(2)
  })

  test("only one step probe is in flight at a time", () => {
    const d = makeDetector()
    d.detector.step()
    d.detector.step()
    d.detector.step()

    expect(d.probe).toHaveBeenCalledTimes(1)
  })

  test("first definitive negative: suspected, one reload, one follow-up at exactly LOGOUT_FOLLOW_UP_MS", async () => {
    const d = makeDetector()

    d.detector.step()
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    // step probes pause while the follow-up is pending
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS - 1)
    expect(d.probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(d.probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("negative follow-up: confirmed with exactly one more reload and no timer left", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)

    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("confirmed")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("inconclusive follow-up: stays suspected, one reschedule at LOGOUT_FOLLOW_UP_MS, then gives up", async () => {
    const d = makeDetector()
    await reachSuspected(d)

    // first follow-up gives no answer: rescheduled once, nothing published
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(INCONCLUSIVE)
    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    d.detector.step() // still paused while the retry is pending
    expect(d.probe).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS - 1)
    expect(d.probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(d.probe).toHaveBeenCalledTimes(3)

    // second inconclusive answer: give up without removal, no more timers
    await d.answer(INCONCLUSIVE)
    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // no more follow-ups even after a long wait
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS * 10)
    expect(d.probe).toHaveBeenCalledTimes(3)
  })

  test("after giving up, step probes resume and a negative one moves to confirmed with one reload", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(INCONCLUSIVE)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(INCONCLUSIVE)
    expect(d.probe).toHaveBeenCalledTimes(3)

    // step probes run on every step now (the memo holds authenticated results only)
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(4)
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("confirmed")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("in confirmed, negative results are no-ops without a reload", async () => {
    const d = makeDetector()
    await reachConfirmed(d)

    d.detector.step()
    await d.answer(LOGGED_OUT)
    d.detector.step()
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("confirmed")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("authenticated clears suspected with one reload and cancels the pending follow-up", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    expect(vi.getTimerCount()).toBe(1)

    d.detector.noteAuthenticated()
    await flush()

    expect(d.state.stage).toBe("none")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    // the cancelled follow-up never fires
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS * 2)
    expect(d.probe).toHaveBeenCalledTimes(1)
  })

  test("authenticated follow-up clears suspected with one reload", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)

    await d.answer(AUTHENTICATED)

    expect(d.state.stage).toBe("none")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("authenticated clears confirmed with one reload and re-arms the memo", async () => {
    const d = makeDetector()
    await reachConfirmed(d)

    d.detector.step()
    await d.answer(AUTHENTICATED)

    expect(d.state.stage).toBe("none")
    expect(d.reload).toHaveBeenCalledTimes(3)
    // memoized again: the next step within the memo starts nothing
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(3)
  })

  test("authenticated in none is a no-op: no reload, but the memo is written", async () => {
    const d = makeDetector()

    d.detector.noteAuthenticated()
    await flush()
    d.detector.step()

    expect(d.reload).not.toHaveBeenCalled()
    expect(d.probe).not.toHaveBeenCalled()
    expect(d.state.stage).toBe("none")
  })

  test("inconclusive step results are ignored in every stage and never memoized", async () => {
    const d = makeDetector()

    // none: nothing published, no follow-up, and the next step probes again
    d.detector.step()
    await d.answer(INCONCLUSIVE)
    expect(d.state.stage).toBe("none")
    expect(d.reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(2)
    await d.answer(LOGGED_OUT)
    expect(d.state.stage).toBe("suspected")

    // suspected after give-up: an inconclusive step keeps the stage
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(INCONCLUSIVE)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(INCONCLUSIVE)
    d.detector.step()
    await d.answer(INCONCLUSIVE)
    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)

    // confirmed: same
    d.detector.step()
    await d.answer(LOGGED_OUT)
    expect(d.state.stage).toBe("confirmed")
    d.detector.step()
    await d.answer(INCONCLUSIVE)
    expect(d.state.stage).toBe("confirmed")
    expect(d.reload).toHaveBeenCalledTimes(2)
  })

  test("installed:false results are ignored: not a logout", async () => {
    const d = makeDetector()

    d.detector.step()
    await d.answer(NOT_INSTALLED)
    expect(d.state.stage).toBe("none")
    expect(d.reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    // as a follow-up it neither confirms nor reschedules
    d.detector.step()
    await d.answer(LOGGED_OUT)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await d.answer(NOT_INSTALLED)
    expect(d.state.stage).toBe("suspected")
    expect(d.reload).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a step result that crossed a login is dropped", async () => {
    const d = makeDetector()
    d.detector.step()
    expect(d.inflight()).toBe(1)

    // the login flow reports authenticated while the probe is still running
    d.detector.noteAuthenticated()
    await flush()
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("none")
    expect(d.reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a follow-up result that crossed a login is dropped", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    expect(d.inflight()).toBe(1)

    d.detector.noteAuthenticated()
    await flush()
    expect(d.state.stage).toBe("none")
    expect(d.reload).toHaveBeenCalledTimes(2)

    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("none")
    expect(d.reload).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("dispose cancels the follow-up, ignores late results and stops further steps", async () => {
    const d = makeDetector()
    await reachSuspected(d)
    expect(vi.getTimerCount()).toBe(1)

    d.detector.dispose()

    expect(vi.getTimerCount()).toBe(0)
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(1)
    d.detector.noteAuthenticated()
    await flush()
    expect(d.reload).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS * 2)
    expect(d.probe).toHaveBeenCalledTimes(1)
  })

  test("a probe answered after dispose changes nothing", async () => {
    const d = makeDetector()
    d.detector.step()
    expect(d.inflight()).toBe(1)

    d.detector.dispose()
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("none")
    expect(d.reload).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a rejecting probe is reported on stderr and never propagates", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = makeDetector()

    expect(() => d.detector.step()).not.toThrow()
    await d.fail(new Error("probe exploded"))

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("probe exploded")
    expect(d.state.stage).toBe("none")
    expect(d.reload).not.toHaveBeenCalled()
    // the next step probes again
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(2)
  })

  test("a rejecting follow-up probe releases the pause so step probes resume", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = makeDetector()
    await reachSuspected(d)
    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)

    await d.fail(new Error("probe exploded"))

    expect(d.state.stage).toBe("suspected")
    d.detector.step()
    expect(d.probe).toHaveBeenCalledTimes(3)
  })

  test("a failing reload is reported on stderr; the transition still holds", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = makeDetector()
    d.reload.mockRejectedValueOnce(new Error("reload failed"))

    d.detector.step()
    await d.answer(LOGGED_OUT)

    expect(d.state.stage).toBe("suspected")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("reload failed")
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe("logout detection: integration flag", () => {
  test("writeLogoutFlag publishes { stage } while flagged and merges with other metadata", () => {
    const state = createLogoutState()
    state.stage = "suspected"
    const ref = { id: "kiro", name: "Kiro", metadata: { other: 1 } } as { id: string; name: string; metadata?: Record<string, unknown> }

    writeLogoutFlag(ref, state)
    expect(ref.metadata).toEqual({ other: 1, [LOGOUT_METADATA_KEY]: { stage: "suspected" } })

    state.stage = "confirmed"
    writeLogoutFlag(ref, state)
    expect(ref.metadata).toEqual({ other: 1, [LOGOUT_METADATA_KEY]: { stage: "confirmed" } })
  })

  test("writeLogoutFlag strips the key when not flagged and drops an emptied metadata record", () => {
    const state = createLogoutState()
    const withOther = { id: "kiro", name: "Kiro", metadata: { other: 1, [LOGOUT_METADATA_KEY]: { stage: "suspected" } } } as {
      id: string
      name: string
      metadata?: Record<string, unknown>
    }
    writeLogoutFlag(withOther, state)
    expect(withOther.metadata).toEqual({ other: 1 })

    const alone = { id: "kiro", name: "Kiro", metadata: { [LOGOUT_METADATA_KEY]: { stage: "confirmed" } } } as {
      id: string
      name: string
      metadata?: Record<string, unknown>
    }
    writeLogoutFlag(alone, state)
    expect("metadata" in alone).toBe(false)

    // untouched when there was nothing to strip
    const bare = { id: "kiro", name: "Kiro" } as { id: string; name: string; metadata?: Record<string, unknown> }
    writeLogoutFlag(bare, state)
    expect("metadata" in bare).toBe(false)
    const unrelated = { id: "kiro", name: "Kiro", metadata: { other: 1 } } as { id: string; name: string; metadata?: Record<string, unknown> }
    writeLogoutFlag(unrelated, state)
    expect(unrelated.metadata).toEqual({ other: 1 })
  })
})

describe("logout detection: session hook through setup()", () => {
  const LOGGED_OUT: AuthStatus = { installed: true, authenticated: false }

  /** the kiro record the integration transform produced on a fresh draft */
  function kiroRecord(h: Harness): { metadata?: Record<string, unknown> } | undefined {
    const integration = makeIntegrationDraft()
    h.integrationTransform(integration.draft)
    return integration.integrations.get("kiro") as { metadata?: Record<string, unknown> } | undefined
  }

  test("setup registers exactly one context hook scoped to the kiro provider", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)

    // the retry guard registers its own session hook; only the context hook is counted here
    const contextCalls = h.raw.session.hook.mock.calls.filter(([name]) => name === "context")
    expect(contextCalls).toHaveLength(1)
    const registration = h.sessionHooks.get("context")
    expect(registration).toBeDefined()
    expect(registration!.options).toEqual({ providerID: "kiro" })
    expect(kiroRecord(h)?.metadata).toBeUndefined()

    await cleanup()
    expect(registration!.dispose).toHaveBeenCalledTimes(1)
  })

  test("context hook accepts the seven-field SessionContext without changing request or retry decisions", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    const sessionHook = h.context.session.hook
    type SessionContext = Parameters<Parameters<typeof sessionHook<"context">>[1]>[0]
    type SessionRetry = Parameters<Parameters<typeof sessionHook<"retry">>[1]>[0]
    const input: SessionContext = {
      sessionID: "session-a" as SessionContext["sessionID"],
      agent: "build" as SessionContext["agent"],
      model: { providerID: Provider.ID.make("kiro"), id: Model.ID.make("model-a") },
      system: [], messages: [], tools: {}, options: { temperature: 0.5, effort: "high" },
    }
    const before = structuredClone(input)
    const callback: Parameters<typeof sessionHook<"context">>[1] = h.sessionHooks.get("context")!.cb
    expect(callback(input)).toBeUndefined()
    await flush()
    expect(mockVerifyAuthAsync).toHaveBeenCalledExactlyOnceWith({ fresh: true })
    expect(input).toEqual(before)
    expect(h.integrationReload).not.toHaveBeenCalled()

    const matcher = vi.mocked(isKiroNotLoggedInError)
    matcher.mockReturnValueOnce(true).mockReturnValueOnce(false)
    try {
      const retryCallback: Parameters<typeof sessionHook<"retry">>[1] = h.sessionHooks.get("retry")!.cb
      const retry: SessionRetry = {
        sessionID: input.sessionID, agent: input.agent, model: input.model, attempt: 1,
        error: { type: "error", message: "Not logged in. Run 'kiro-cli login' to authenticate." },
        decision: { retry: true, delay: 1_500 },
      }
      await retryCallback(retry)
      expect(retry.decision).toEqual({ retry: false })
      const unrelated: SessionRetry = {
        ...retry, error: { type: "error", message: "Service unavailable" },
        decision: { retry: true, delay: 1_500 },
      }
      const proposed = unrelated.decision
      await retryCallback(unrelated)
      expect(unrelated.decision).toBe(proposed)
    } finally {
      matcher.mockReset()
      await cleanup()
    }
  })

  test("a kiro step runs a fresh probe without delaying the step; a negative flags the integration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let release!: (status: AuthStatus) => void
    mockVerifyAuthAsync.mockImplementationOnce(
      () =>
        new Promise<AuthStatus>((resolve) => {
          release = resolve
        }),
    )
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    const hook = h.sessionHooks.get("context")!

    // the hook returns before the probe answers (the SDK import is lazy, so the
    // probe call itself lands a microtask later)
    const returned = hook.cb({ sessionID: "s", agent: "build", model: { providerID: "kiro", modelID: "m" }, input: {} })
    expect(returned).toBeUndefined()
    await flush()
    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(1)
    expect(mockVerifyAuthAsync).toHaveBeenCalledWith({ fresh: true })
    expect(h.integrationReload).not.toHaveBeenCalled()

    release(LOGGED_OUT)
    await flush()

    expect(h.integrationReload).toHaveBeenCalledTimes(1)
    expect(kiroRecord(h)?.metadata).toEqual({ [LOGOUT_METADATA_KEY]: { stage: "suspected" } })
    expect(vi.getTimerCount()).toBe(1) // the follow-up

    await cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("the follow-up confirms through the SDK probe and the transform publishes confirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValue(LOGGED_OUT)
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    const hook = h.sessionHooks.get("context")!

    hook.cb({ sessionID: "s", agent: "build", model: { providerID: "kiro", modelID: "m" }, input: {} })
    await flush()
    expect(kiroRecord(h)?.metadata).toEqual({ [LOGOUT_METADATA_KEY]: { stage: "suspected" } })

    await vi.advanceTimersByTimeAsync(LOGOUT_FOLLOW_UP_MS)
    await flush()

    expect(mockVerifyAuthAsync).toHaveBeenCalledTimes(2)
    expect(h.integrationReload).toHaveBeenCalledTimes(2)
    expect(kiroRecord(h)?.metadata).toEqual({ [LOGOUT_METADATA_KEY]: { stage: "confirmed" } })

    await cleanup()
  })

  test("the hook never rejects when the SDK probe fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mockVerifyAuthAsync.mockRejectedValueOnce(new Error("spawn failed"))
      const h = makeMockContext()
      const cleanup = await runSetup(h)
      const hook = h.sessionHooks.get("context")!

      await expect(
        Promise.resolve(hook.cb({ sessionID: "s", agent: "build", model: { providerID: "kiro", modelID: "m" }, input: {} })),
      ).resolves.toBeUndefined()
      await flush()

      expect(h.integrationReload).not.toHaveBeenCalled()
      expect(kiroRecord(h)?.metadata).toBeUndefined()
      await cleanup()
    } finally {
      errorSpy.mockRestore()
    }
  })

  test("an already-authenticated authorize() clears the flag with one reload and cancels the follow-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    mockVerifyAuthAsync.mockResolvedValueOnce(LOGGED_OUT)
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)
    const hook = h.sessionHooks.get("context")!

    hook.cb({ sessionID: "s", agent: "build", model: { providerID: "kiro", modelID: "m" }, input: {} })
    await flush()
    expect(h.integrationReload).toHaveBeenCalledTimes(1)
    expect(kiroRecord(h)?.metadata).toEqual({ [LOGOUT_METADATA_KEY]: { stage: "suspected" } })
    expect(vi.getTimerCount()).toBe(1)

    // the user reconnects; kiro-cli is already logged in again
    const authorization = await authorize({})
    await flush()
    expect(authorization.mode).toBe("auto")
    expect(mockExecFile).not.toHaveBeenCalled()

    expect(h.integrationReload).toHaveBeenCalledTimes(2)
    expect(kiroRecord(h)?.metadata).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("a successful login poll clears the flag as well", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    let authenticated = false
    mockVerifyAuthAsync.mockImplementation(async () => ({ installed: true, authenticated }))
    const h = makeMockContext()
    const { cleanup, authorize } = await setupWithAuthorize(h)
    const hook = h.sessionHooks.get("context")!

    hook.cb({ sessionID: "s", agent: "build", model: { providerID: "kiro", modelID: "m" }, input: {} })
    await flush()
    expect(kiroRecord(h)?.metadata).toEqual({ [LOGOUT_METADATA_KEY]: { stage: "suspected" } })

    const authorization = await authorize({})
    const credential = expect(authorization.callback).resolves.toEqual(EXPECTED_CREDENTIAL)
    authenticated = true
    await vi.advanceTimersByTimeAsync(2_000)
    await credential
    await flush()

    expect(kiroRecord(h)?.metadata).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    await cleanup()
  })

  test("cleanup disposes the hook registration once and is idempotent", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    const hook = h.sessionHooks.get("context")!

    await cleanup()
    await cleanup()

    expect(hook.dispose).toHaveBeenCalledTimes(1)
    // the shared session-dispose knob also counts the retry guard's registration
    expect(h.disposeSpies.session).toHaveBeenCalledTimes(h.sessionHooks.size)
  })
})

describe("retry safety net", () => {
  const messageCases = [
    {
      name: "login instruction",
      error: { type: "error", message: "Not logged in. Run 'kiro-cli login' to authenticate." },
    },
    {
      name: "re-authentication guidance",
      error: {
        type: "error",
        message:
          "Kiro could not complete the request and does not appear logged in. Run 'kiro-cli whoami' " +
          "to check auth and 'kiro-cli doctor' to diagnose installation, credential, or environment issues; " +
          "then 'kiro-cli login' if needed (or /connect in opencode). Original: Internal error",
      },
    },
  ]
  const unrelatedError = { type: "api", message: "Service temporarily unavailable", status: 503 }
  const sdkMatcher = vi.mocked(isKiroNotLoggedInError)
  let sdk: typeof import("kiro-acp-ai-provider")
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(async () => {
    // Use the installed SDK's pure matcher without replacing the process and
    // auth mocks. Await imports serially so mocked module loading cannot race.
    sdk = await vi.importActual<typeof import("kiro-acp-ai-provider")>("kiro-acp-ai-provider")
    sdkMatcher.mockReset()
    sdkMatcher.mockImplementation(sdk.isKiroNotLoggedInError)
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy?.mockRestore()
    errorSpy = undefined
    sdkMatcher.mockReset()
  })

  function retryInput(error: RetryInput["error"], decision: RetryDecision = { retry: true, delay: 1_500 }) {
    return {
      sessionID: "s",
      agent: "build",
      model: { providerID: "kiro", modelID: "m" },
      attempt: 1,
      error,
      decision,
    }
  }

  test.each(messageCases)("stops retries when the SDK matcher recognizes the $name", async ({ error }) => {
    const loadMatcher = vi.fn(async () => sdkMatcher)
    const guard = createRetryGuard({ loadMatcher })
    const input = retryInput(error)

    await expect(guard.decide(input)).resolves.toBeUndefined()

    expect(loadMatcher).toHaveBeenCalledTimes(1)
    expect(sdkMatcher).toHaveBeenCalledExactlyOnceWith(error)
    expect(input.decision).toEqual({ retry: false })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("stops retries for a marker-bearing error even without either login phrase", async () => {
    const guard = createRetryGuard({ loadMatcher: async () => sdkMatcher })
    // Extra fields are structurally accepted in process; the host currently
    // forwards only type, message and status, covered by the message cases.
    const error = { ...unrelatedError, data: { reason: sdk.KIRO_NOT_LOGGED_IN_REASON } }
    const input = retryInput(error)

    await expect(guard.decide(input)).resolves.toBeUndefined()

    expect(sdkMatcher).toHaveBeenCalledExactlyOnceWith(error)
    expect(input.decision).toEqual({ retry: false })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test.each<RetryDecision>([{ retry: true, delay: 4_321 }, { retry: false }])(
    "preserves the host decision for an unrelated error when retry is $retry",
    async (decision) => {
      const proposed = Object.freeze({ ...decision })
      const input = retryInput(unrelatedError, proposed)
      const guard = createRetryGuard({ loadMatcher: async () => sdkMatcher })

      await expect(guard.decide(input)).resolves.toBeUndefined()

      expect(sdkMatcher).toHaveBeenCalledExactlyOnceWith(unrelatedError)
      expect(input.decision).toBe(proposed)
      expect(input.decision).toEqual(decision)
      expect(errorSpy).not.toHaveBeenCalled()
    },
  )

  test("a rejecting matcher import uses both local phrases, logs once and never rejects", async () => {
    const loadMatcher = vi.fn().mockRejectedValue(new Error("matcher import failed"))
    const guard = createRetryGuard({ loadMatcher })

    for (const { error } of [...messageCases, ...messageCases]) {
      const input = retryInput(error)
      await expect(guard.decide(input)).resolves.toBeUndefined()
      expect(input.decision).toEqual({ retry: false })
    }
    for (const decision of [{ retry: true, delay: 4_321 }, { retry: false }] satisfies RetryDecision[]) {
      const proposed = Object.freeze({ ...decision })
      const input = retryInput(unrelatedError, proposed)
      await expect(guard.decide(input)).resolves.toBeUndefined()
      expect(input.decision).toBe(proposed)
      expect(input.decision).toEqual(decision)
    }

    expect(loadMatcher).toHaveBeenCalled()
    expect(sdkMatcher).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[opencode-kiro] not-logged-in matcher unavailable, using the built-in phrase check: matcher import failed",
    )
  })

  test.each(messageCases)("does not apply the local $name when the SDK matcher returns false", async ({ error }) => {
    sdkMatcher.mockReturnValue(false)
    const guard = createRetryGuard({ loadMatcher: async () => sdkMatcher })
    const proposed = Object.freeze({ retry: true as const, delay: 4_321 })
    const input = retryInput(error, proposed)

    await expect(guard.decide(input)).resolves.toBeUndefined()

    expect(sdkMatcher).toHaveBeenCalledExactlyOnceWith(error)
    expect(input.decision).toBe(proposed)
    expect(input.decision).toEqual({ retry: true, delay: 4_321 })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("a throwing SDK matcher leaves the host decision untouched without applying the local phrases", async () => {
    sdkMatcher.mockImplementation(() => {
      throw new Error("classification failed")
    })
    const guard = createRetryGuard({ loadMatcher: async () => sdkMatcher })
    const proposed = Object.freeze({ retry: true as const, delay: 4_321 })
    const input = retryInput(messageCases[0].error, proposed)

    await expect(guard.decide(input)).resolves.toBeUndefined()

    expect(sdkMatcher).toHaveBeenCalledExactlyOnceWith(input.error)
    expect(input.decision).toBe(proposed)
    expect(input.decision).toEqual({ retry: true, delay: 4_321 })
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[opencode-kiro] retry guard could not classify the error: classification failed",
    )
  })

  test.each([
    { name: "undefined input", value: undefined },
    { name: "null input", value: null },
    { name: "numeric input", value: 42 },
    { name: "missing error", value: {} },
    { name: "null error", value: { error: null } },
    { name: "non-string message", value: { error: { type: "error", message: 42 } } },
  ])("never rejects for $name with either the SDK matcher or local fallback", async ({ value }) => {
    const guards = [
      createRetryGuard({ loadMatcher: async () => sdkMatcher }),
      createRetryGuard({ loadMatcher: vi.fn().mockRejectedValue(new Error("matcher import failed")) }),
    ]
    for (const guard of guards) {
      // Deliberately bypass the host's static contract to exercise malformed values.
      await expect(guard.decide(value as unknown as RetryInput)).resolves.toBeUndefined()
    }
  })

  test("an unreadable error leaves the decision untouched and never rejects", async () => {
    const proposed = Object.freeze({ retry: true as const, delay: 4_321 })
    const input = {
      ...retryInput(unrelatedError, proposed),
      get error(): RetryInput["error"] {
        throw new Error("error unavailable")
      },
    }
    const guard = createRetryGuard({ loadMatcher: async () => sdkMatcher })

    await expect(guard.decide(input)).resolves.toBeUndefined()

    expect(input.decision).toBe(proposed)
    expect(input.decision).toEqual({ retry: true, delay: 4_321 })
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[opencode-kiro] retry guard could not classify the error: error unavailable",
    )
  })

  test("setup registers exactly one retry hook scoped to the kiro provider and applies the guard", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    try {
      const retryCalls = h.raw.session.hook.mock.calls.filter(([name]) => name === "retry")
      expect(retryCalls).toHaveLength(1)
      const hook = h.sessionHooks.get("retry")!
      expect(hook).toBeDefined()
      expect(hook.options).toEqual({ providerID: "kiro" })
      expect(hook.dispose).not.toHaveBeenCalled()
      expect(sdkMatcher).not.toHaveBeenCalled()

      for (const { error } of messageCases) {
        const input = retryInput(error)
        await expect(Promise.resolve(hook.cb(input))).resolves.toBeUndefined()
        expect(input.decision).toEqual({ retry: false })
      }
      const proposed = Object.freeze({ retry: true as const, delay: 4_321 })
      const input = retryInput(unrelatedError, proposed)
      await expect(Promise.resolve(hook.cb(input))).resolves.toBeUndefined()
      expect(input.decision).toBe(proposed)
      expect(input.decision).toEqual({ retry: true, delay: 4_321 })
      expect(sdkMatcher.mock.calls).toEqual([...messageCases.map(({ error }) => [error]), [unrelatedError]])
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  test("cleanup disposes the retry hook exactly once across concurrent and repeated calls", async () => {
    const h = makeMockContext()
    const cleanup = await runSetup(h)
    const hook = h.sessionHooks.get("retry")!
    expect(hook).toBeDefined()
    expect(hook.dispose).not.toHaveBeenCalled()

    const first = cleanup()
    const second = cleanup()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(hook.dispose).toHaveBeenCalledTimes(1)

    await cleanup()
    expect(hook.dispose).toHaveBeenCalledTimes(1)
    expect(h.disposeSpies.session).toHaveBeenCalledTimes(2)
    expect(h.sessionHooks.get("context")!.dispose).toHaveBeenCalledTimes(1)
  })
})
