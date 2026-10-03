import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test, vi } from "vitest"
import {
  creditsChipText,
  creditsForMessage,
  formatCredits,
  messageCredits,
  readPartCredits,
  spendLines,
  sumSessionCredits,
  type CreditMessage,
  type CreditPart,
  type SessionCredits,
} from "../src/tui/credits"
import {
  LOGOUT_DIALOG_MESSAGE,
  LOGOUT_DIALOG_TITLE,
  PROVIDER_CONNECT_COMMAND,
  createLogoutWatcher,
  kiroCredentialIDs,
  readLogoutStage,
  type LogoutIntegration,
  type LogoutLocation,
} from "../src/tui/logout"

// Credit-helper + TUI wiring tests. Fixtures are plain content-part shaped
// objects carrying key-unwrapped state (`part.state.credits` /
// `part.state.creditsUnit`) - never `part.state.kiro` and never the legacy
// `part.metadata.kiro` (both are forbidden read shapes). Core hazard is dual
// emission: one message carries the same turn total on its text and reasoning
// parts, so credits count once per message (last carrier wins).

/** Part-shaped fixture carrying key-unwrapped credit state. */
const statePart = (type: string, state: unknown): CreditPart => ({ type, state })

const assistant = (id: string): CreditMessage => ({ id, role: "assistant" })

/** partsByMessage lookup over a plain fixture table. */
const lookup =
  (table: Record<string, ReadonlyArray<CreditPart>>) =>
  (messageID: string): ReadonlyArray<CreditPart> =>
    table[messageID] ?? []

describe("readPartCredits (v2 state shape)", () => {
  test("reads credits from text part state", () => {
    const part = statePart("text", { credits: 1.5, creditsUnit: "credit" })

    expect(readPartCredits(part)).toEqual({ credits: 1.5, unit: "credit" })
  })

  test("reads credits from reasoning part state", () => {
    const part = statePart("reasoning", { credits: 4, creditsUnit: "credit" })

    expect(readPartCredits(part)).toEqual({ credits: 4, unit: "credit" })
  })

  test("rejects the wrapped state.kiro shape", () => {
    // the host stores metadata[providerMetadataKey] key-unwrapped; a provider-keyed
    // nest must never be read
    const part = statePart("text", { kiro: { credits: 1, creditsUnit: "credit" } })

    expect(readPartCredits(part)).toBeUndefined()
  })

  test("rejects the v1 metadata.kiro shape", () => {
    const v1Part: CreditPart = { type: "text", metadata: { kiro: { credits: 1, creditsUnit: "credit" } } }

    expect(readPartCredits(v1Part)).toBeUndefined()
  })

  test("rejects non-finite credits and omits empty units", () => {
    expect(readPartCredits(statePart("text", { credits: Number.NaN }))).toBeUndefined()
    expect(readPartCredits(statePart("text", { credits: Number.POSITIVE_INFINITY }))).toBeUndefined()
    expect(readPartCredits(statePart("text", { credits: "7" }))).toBeUndefined() // string credits
    expect(readPartCredits(statePart("text", null))).toBeUndefined()
    expect(readPartCredits(statePart("text", "not-an-object"))).toBeUndefined()

    // empty-string unit is dropped while the finite credits value survives
    expect(readPartCredits(statePart("text", { credits: 2, creditsUnit: "" }))).toEqual({
      credits: 2,
      unit: undefined,
    })
  })

  test("rejects parts that are not text or reasoning", () => {
    expect(readPartCredits(statePart("step-start", { credits: 1, creditsUnit: "credit" }))).toBeUndefined()
    expect(readPartCredits(statePart("tool", { credits: 1 }))).toBeUndefined()
    expect(readPartCredits({} as CreditPart)).toBeUndefined()
  })
})

describe("credit dedupe per message", () => {
  test("dual emission counted once per message", () => {
    // Reasoning + text parts of one message both carry the turn total (3).
    const parts = [
      statePart("reasoning", { credits: 3, creditsUnit: "credit" }),
      statePart("text", { credits: 3, creditsUnit: "credit" }),
    ]

    const credits = creditsForMessage(parts)

    expect(credits).toBe(3) // not 6: carriers are never summed within a message
  })

  test("last carrier wins within a message; unit backfills from part order", () => {
    // Differing values prove last-wins (not max/sum): the unit-less final
    // carrier takes the credits, unit falls back to the last part that had one.
    const parts = [
      statePart("reasoning", { credits: 2, creditsUnit: "credit" }),
      statePart("text", { credits: 5 }),
    ]

    const result = messageCredits(parts)

    expect(result).toEqual({ credits: 5, unit: "credit" }) // not 2, not 7
  })
})

describe("sumSessionCredits", () => {
  test("sums across multiple assistant messages", () => {
    const messages = [
      { id: "msg_user", role: "user" }, // role-filtered out even with a carrier
      assistant("msg_1"),
      assistant("msg_2"),
      assistant("msg_3"),
    ]
    const partsByMessage = lookup({
      msg_user: [statePart("text", { credits: 100, creditsUnit: "credit" })],
      msg_1: [statePart("text", { credits: 1, creditsUnit: "credit" })],
      msg_2: [statePart("text", { credits: 2, creditsUnit: "credit" })],
      msg_3: [
        // Dual emission inside the rollup still counts once.
        statePart("reasoning", { credits: 3.5, creditsUnit: "credit" }),
        statePart("text", { credits: 3.5, creditsUnit: "credit" }),
      ],
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result).toEqual({ total: 6.5, unit: "credit", present: true }) // 1 + 2 + 3.5
  })

  test("messages without credit state contribute 0", () => {
    // Mixed session: empty, state-less, malformed, and non-finite credits
    // all contribute nothing; only the real carrier counts (no NaN).
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3"), assistant("msg_4")]
    const partsByMessage = lookup({
      msg_1: [],
      msg_2: [{ type: "text", text: "plain" }, { type: "step-start" }],
      msg_3: [
        statePart("text", null),
        statePart("text", "not-an-object"), // must not throw
        statePart("text", { credits: Number.NaN }),
        statePart("text", { credits: Number.POSITIVE_INFINITY }),
        statePart("text", { credits: "7" }), // string credits don't count
      ],
      msg_4: [statePart("text", { credits: 4 })],
    })

    const compute = (): ReturnType<typeof sumSessionCredits> => sumSessionCredits(messages, partsByMessage)

    expect(compute).not.toThrow()
    const result = compute()
    expect(result.total).toBe(4)
    expect(Number.isFinite(result.total)).toBe(true)
    expect(result.unit).toBeUndefined() // no carrier ever reported a unit
  })

  test("forbidden carrier shapes are ignored", () => {
    // Only key-unwrapped part.state counts: wrapped state.kiro, v1 metadata.kiro,
    // and providerMetadata are all dead read paths in v2.
    const wrappedState = statePart("text", { kiro: { credits: 9, creditsUnit: "credit" } })
    const v1Metadata: CreditPart = { type: "text", metadata: { kiro: { credits: 9, creditsUnit: "credit" } } }
    const providerMetadata: CreditPart = { type: "text", providerMetadata: { kiro: { credits: 9 } } }

    expect(creditsForMessage([wrappedState, v1Metadata, providerMetadata])).toBeUndefined()
    const result = sumSessionCredits([assistant("msg_1")], () => [wrappedState, v1Metadata, providerMetadata])
    expect(result).toEqual({ total: 0, unit: undefined, present: false })
  })

  test("present distinguishes a real kiro turn from no credit state", () => {
    // The view picks credits-vs-"$X spent" off `present`, not `total`, because a
    // genuine kiro turn worth 0 credits is indistinguishable from a non-kiro
    // session by total alone.
    const noKiro = sumSessionCredits([assistant("msg_1")], () => [{ type: "text", text: "plain" }])
    expect(noKiro).toEqual({ total: 0, unit: undefined, present: false })

    const zeroCreditKiroTurn = sumSessionCredits([assistant("msg_1")], () => [
      statePart("text", { credits: 0, creditsUnit: "credit" }),
    ])
    expect(zeroCreditKiroTurn).toEqual({ total: 0, unit: "credit", present: true })
  })

  test("unit taken from most recent carrier", () => {
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3")]
    const partsByMessage = lookup({
      msg_1: [statePart("text", { credits: 1, creditsUnit: "credits" })], // older unit
      msg_2: [statePart("text", { credits: 2, creditsUnit: "points" })], // newest unit
      msg_3: [statePart("text", { credits: 3 })], // unit-less carrier must not erase it
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result.unit).toBe("points")
    expect(result.total).toBe(6)
  })
})

describe("formatCredits", () => {
  test("formatCredits edge cases", () => {
    // kiro-cli reports singular "credit"; pluralize unless value is 1 or the
    // unit already ends in "s".
    expect(formatCredits(0, "credit")).toBe("0 credits")
    expect(formatCredits(0.5, "credit")).toBe("0.5 credits")
    expect(formatCredits(12, "credit")).toBe("12 credits")
    expect(formatCredits(12.5, "credit")).toBe("12.5 credits")
    expect(formatCredits(1, "credit")).toBe("1 credit") // singular preserved
    expect(formatCredits(2, "points")).toBe("2 points") // never "pointss"

    // No unit known: bare number, never an invented unit string.
    expect(formatCredits(0)).toBe("0")
    expect(formatCredits(0.5)).toBe("0.5")
    expect(formatCredits(12)).toBe("12")
    for (const value of [0, 0.5, 12]) {
      expect(formatCredits(value)).not.toContain("undefined")
    }
  })
})

describe("spendLines", () => {
  /** SessionCredits fixture; defaults to the no-kiro-metadata (dollars-only) shape. */
  const sc = (over: Partial<SessionCredits> = {}): SessionCredits => ({
    total: 0,
    unit: undefined,
    present: false,
    ...over,
  })

  test("dollars only: cost>0 with no credits => one '$X.XX spent' line", () => {
    expect(spendLines({ cost: 5, credits: sc() })).toEqual(["$5.00 spent"])
  })

  test("Kiro only: credits present with cost 0 => one credits line", () => {
    expect(spendLines({ cost: 0, credits: sc({ total: 100, unit: "credit", present: true }) })).toEqual([
      "100 credits",
    ])
  })

  test("both: cost>0 and credits present => two stacked lines (dollars then credits)", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 100, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "100 credits",
    ])
  })

  test("empty: cost 0 with no credits => '$0.00 spent'", () => {
    expect(spendLines({ cost: 0, credits: sc() })).toEqual(["$0.00 spent"])
  })

  test("both singular: pluralization reuses formatCredits (total 1 => '1 credit')", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 1, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "1 credit",
    ])
  })

  test("both unit-less: bare number on the credits line", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 12, unit: undefined, present: true }) })).toEqual([
      "$5.00 spent",
      "12",
    ])
  })

  test("zero-credit-but-present Kiro turn with cost>0 stays in the both branch", () => {
    expect(spendLines({ cost: 5, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual([
      "$5.00 spent",
      "0 credits",
    ])
  })

  test("zero-credit-but-present Kiro turn with cost 0 stays in the credits-only branch", () => {
    expect(spendLines({ cost: 0, credits: sc({ total: 0, unit: "credit", present: true }) })).toEqual(["0 credits"])
  })
})

describe("creditsChipText", () => {
  test("renders the formatted total; collapses without kiro credits", () => {
    expect(creditsChipText({ total: 2, unit: "credit", present: true })).toBe("2 credits")
    expect(creditsChipText({ total: 0, unit: undefined, present: true })).toBe("0")
    expect(creditsChipText({ total: 0, unit: undefined, present: false })).toBe("")
  })
})

// --- TUI setup/cleanup suite (two append claims: `sidebar.content` +
// `prompt.footer.status`; `ui.slot` takes a claim object) -----------------------
// The view modules lazy-import @opentui/solid inside setup. The box view is mocked
// as the test seam (marker node exposing the injected credits accessor + theme
// tokens); the chip view stays real against lightweight @opentui/solid + solid-js
// fakes so its single-line/collapse/theming behavior is testable without the
// Bun-native renderer. Host rendering itself is out of scope here.

/** Marker node returned by the mocked box-view factory; exposes accessor + tokens. */
interface FakeViewNode {
  kind: "credits-box"
  credits: () => SessionCredits
  tokens: unknown
}

/** Fake @opentui/solid DomNode: tag + props + inserted content accessors/children. */
interface FakeDomNode {
  tag: string
  props: Record<string, unknown>
  children: unknown[]
}

vi.mock("@opentui/solid", () => ({
  createElement: (tag: string): FakeDomNode => ({ tag, props: {}, children: [] }),
  setProp: (node: FakeDomNode, key: string, value: unknown): void => {
    node.props[key] = value
  },
  insert: (node: FakeDomNode, content: unknown): void => {
    node.children.push(content)
  },
  insertNode: (node: FakeDomNode, child: unknown): void => {
    node.children.push(child)
  },
}))

// Deterministic client-like solid semantics: plain Node resolves solid-js to the
// once-eval server build (frozen memos), so the fake keeps memos as pass-through
// accessors and signals as plain boxes — matching how the host's client build
// re-evaluates render-path reads.
vi.mock("solid-js", () => ({
  createMemo: <T>(fn: () => T): (() => T) => fn,
  createSignal: <T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => T] => {
    let value = initial
    return [
      () => value,
      (next) => {
        value = typeof next === "function" ? (next as (prev: T) => T)(value) : next
        return value
      },
    ]
  },
}))

vi.mock("../src/tui/credits-box-view.js", () => ({
  createCreditsBoxView: (credits: () => SessionCredits, tokens: unknown): FakeViewNode => ({
    kind: "credits-box",
    credits,
    tokens,
  }),
}))

/** Minimal durable message shape served by the mock `data.session.message.list`. */
interface FixtureMessage {
  id: string
  type: string
  content?: ReadonlyArray<CreditPart>
}

/** Recorded `ui.slot` claim registration (claims API: one placement key + render). */
interface SlotRegistration {
  claim: Record<string, unknown>
  render: (props: Record<string, unknown>) => unknown
  unregisterCalls: number
}

interface MockTuiContext {
  context: {
    ui: {
      slot: (...args: unknown[]) => () => void
      dialog?: { confirm: ReturnType<typeof vi.fn> }
    }
    data: {
      on: (event: string, handler: (event: unknown) => void) => () => void
      session: {
        message: {
          list: (sessionID: string) => ReadonlyArray<FixtureMessage> | undefined
          sync: ReturnType<typeof vi.fn>
        }
      }
      location?: {
        integration: {
          invalidate: ReturnType<typeof vi.fn>
          sync: ReturnType<typeof vi.fn>
          list: ReturnType<typeof vi.fn>
        }
      }
    }
    client?: { credential: { remove: ReturnType<typeof vi.fn> } }
    keymap?: { dispatch: ReturnType<typeof vi.fn> }
    location?: LogoutLocation
    theme?: unknown
    storage?: { memory: ReturnType<typeof vi.fn> }
  }
  slots: SlotRegistration[]
  slotCalls: unknown[][]
  listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }>
  sync: ReturnType<typeof vi.fn>
  memoryStores: Map<string, unknown>
  /** logout surfaces (present when `withLogout` was requested) */
  logout?: LogoutSurfaces
}

/** Spies behind the credential/dialog/keymap/integration surfaces the logout watcher uses. */
interface LogoutSurfaces {
  remove: ReturnType<typeof vi.fn<(input: unknown) => Promise<unknown>>>
  confirm: ReturnType<typeof vi.fn<(options: unknown) => Promise<boolean | undefined>>>
  dispatch: ReturnType<typeof vi.fn<(id: string) => void>>
  integrationInvalidate: ReturnType<typeof vi.fn<(location?: LogoutLocation) => void>>
  integrationSync: ReturnType<typeof vi.fn<(location?: LogoutLocation) => Promise<void>>>
  integrationList: ReturnType<typeof vi.fn<(location?: LogoutLocation) => ReadonlyArray<LogoutIntegration> | undefined>>
  /** replace the integration list every `list()` call returns */
  setIntegrations: (integrations: ReadonlyArray<LogoutIntegration> | undefined) => void
}

const makeLogoutSurfaces = (): LogoutSurfaces => {
  let integrations: ReadonlyArray<LogoutIntegration> | undefined = []
  return {
    remove: vi.fn(async (_input: unknown) => ({}) as unknown),
    confirm: vi.fn(async (_options: unknown): Promise<boolean | undefined> => undefined),
    dispatch: vi.fn((_id: string) => {}),
    integrationInvalidate: vi.fn((_location?: LogoutLocation) => {}),
    integrationSync: vi.fn(async (_location?: LogoutLocation) => {}),
    integrationList: vi.fn((_location?: LogoutLocation) => integrations),
    setIntegrations: (next) => {
      integrations = next
    },
  }
}

/**
 * Mock TUI context: records slot-claim/listener registrations with
 * call-counting disposers and serves durable message fixtures from a mutable
 * table. `failUnregisterOf` makes that claim path's disposer throw (cleanup
 * aggregation). `theme` (feature-detected tokens) and `withMemoryStorage`
 * (TUI `storage.memory`) are opt-in — both absent by default so the fallback
 * paths stay the baseline under test. `withLogout` adds the credential,
 * dialog, keymap and integration surfaces the logout watcher drives.
 */
const makeTuiContext = (options?: {
  messages?: Record<string, ReadonlyArray<FixtureMessage>>
  failUnregisterOf?: string
  theme?: unknown
  withMemoryStorage?: boolean
  withLogout?: { location?: LogoutLocation }
}): MockTuiContext => {
  const slots: SlotRegistration[] = []
  const slotCalls: unknown[][] = []
  const listeners: Array<{ event: string; handler: (event: unknown) => void; unsubscribeCalls: number }> = []
  const sync = vi.fn()
  const memoryStores = new Map<string, unknown>()
  const context: MockTuiContext["context"] = {
    ui: {
      slot: (...args: unknown[]) => {
        slotCalls.push(args)
        const claim = args[0] as Record<string, unknown> & {
          render: (props: Record<string, unknown>) => unknown
        }
        const registration: SlotRegistration = { claim, render: claim.render, unregisterCalls: 0 }
        slots.push(registration)
        return () => {
          registration.unregisterCalls += 1
          if (options?.failUnregisterOf !== undefined && claim.append === options.failUnregisterOf)
            throw new Error(`unregister ${options.failUnregisterOf} failed`)
        }
      },
    },
    data: {
      on: (event, handler) => {
        const registration = { event, handler, unsubscribeCalls: 0 }
        listeners.push(registration)
        return () => {
          registration.unsubscribeCalls += 1
        }
      },
      session: { message: { list: (sessionID) => options?.messages?.[sessionID], sync } },
    },
  }
  if (options?.theme !== undefined) context.theme = options.theme
  if (options?.withMemoryStorage) {
    // memory-backed stores outlive one plugin generation: same key -> same store
    context.storage = {
      memory: vi.fn((key: string, opts: { initial: unknown }) => {
        if (!memoryStores.has(key)) memoryStores.set(key, opts.initial)
        return [memoryStores.get(key)]
      }),
    }
  }
  let logout: LogoutSurfaces | undefined
  if (options?.withLogout) {
    logout = makeLogoutSurfaces()
    context.ui.dialog = { confirm: logout.confirm }
    context.client = { credential: { remove: logout.remove } }
    context.keymap = { dispatch: logout.dispatch }
    context.data.location = {
      integration: {
        invalidate: logout.integrationInvalidate,
        sync: logout.integrationSync,
        list: logout.integrationList,
      },
    }
    if (options.withLogout.location) context.location = options.withLogout.location
  }
  return { context, slots, slotCalls, listeners, sync, memoryStores, logout }
}

/** Load the TUI plugin (box view mocked above) and run setup against a mock context. */
const setupPlugin = async (
  mock: MockTuiContext,
): Promise<() => Promise<void>> => {
  const { default: plugin } = await import("../src/tui")
  return (await plugin.setup(mock.context as never)) as () => Promise<void>
}

/** Find the registration claiming `append: path`. */
const claimFor = (mock: MockTuiContext, path: string): SlotRegistration => {
  const slot = mock.slots.find((registration) => registration.claim.append === path)
  expect(slot, `append claim for ${path} must be registered`).toBeDefined()
  return slot!
}

/** Render a registered slot claim and return its reactive accessor (view-or-null). */
const renderSlot = (mock: MockTuiContext, path: string, props: Record<string, unknown>): (() => unknown) =>
  claimFor(mock, path).render(props) as () => unknown

/** The box-view accessor for the sidebar claim (typed marker seam). */
const renderSidebar = (mock: MockTuiContext, props: Record<string, unknown>): (() => FakeViewNode | null) =>
  renderSlot(mock, "sidebar.content", props) as () => FakeViewNode | null

describe("tui setup registrations", () => {
  test("setup registers two append claims (sidebar.content + prompt.footer.status) and three listeners (text/reasoning ended, integration.updated)", async () => {
    const mock = makeTuiContext()

    const cleanup = await setupPlugin(mock)

    // box in the sidebar + chip in the prompt footer row, both additive
    // (`append` is the only placement key on each claim — never `replace`)
    expect(mock.slots.map((slot) => slot.claim.append)).toEqual(["sidebar.content", "prompt.footer.status"])
    for (const slot of mock.slots) {
      expect(Object.keys(slot.claim).sort()).toEqual(["append", "render"])
      expect(typeof slot.claim.render).toBe("function")
    }
    // credits ride whichever part closes the turn, so both ended events feed the same
    // recording path; integration.updated drives the logout dialog
    expect(mock.listeners.map((listener) => listener.event)).toEqual([
      "session.text.ended",
      "session.reasoning.ended",
      "integration.updated",
    ])
    await cleanup()
  })

  test("no old-signature slot calls: every registration is a single claim object", async () => {
    const mock = makeTuiContext()

    const cleanup = await setupPlugin(mock)

    // the host only accepts a claim object; a string first arg or a second
    // render arg would silently no-op in the host
    expect(mock.slotCalls).toHaveLength(2)
    for (const args of mock.slotCalls) {
      expect(args).toHaveLength(1)
      expect(typeof args[0]).toBe("object")
    }
    await cleanup()
  })

  test("text-ended handler records to the store; malformed payloads never throw", async () => {
    // durable text part has no state (the live reducer bug this handler works around)
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    const credits = renderSidebar(mock, { sessionID: "sess" })

    expect(credits()).toBeNull() // nothing recorded yet -> surface withheld

    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const view = credits()
    expect(view).not.toBeNull()
    expect(view!.credits()).toEqual({ total: 5, unit: "credit", present: true })

    // never-throw discipline: garbage payloads are swallowed and change nothing
    const malformed = [undefined, null, 42, "nope", {}, { data: null }, { data: { state: { credits: 1 } } }]
    for (const payload of malformed) {
      expect(() => handler(payload)).not.toThrow()
    }
    expect(credits()!.credits()).toEqual({ total: 5, unit: "credit", present: true })
    await cleanup()
  })

  test("render data assembly = reconcile + merge; durable stays authoritative", async () => {
    const messages: Record<string, ReadonlyArray<FixtureMessage>> = {
      sess: [
        { id: "msg_user", type: "user", content: [] },
        { id: "msg_1", type: "assistant", content: [statePart("text", { credits: 1, creditsUnit: "credit" })] },
        { id: "msg_2", type: "assistant", content: [{ type: "text", text: "no state yet" }] },
      ],
    }
    const mock = makeTuiContext({ messages })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    // stale transient for msg_1 (durable already carries 1) + live transient for msg_2
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 99, creditsUnit: "credit" } } })
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_2", ordinal: 0, state: { credits: 2, creditsUnit: "credit" } } })

    const sidebar = renderSidebar(mock, { sessionID: "sess" })

    // durable 1 (authoritative over stale 99) + transient 2; never 1+99+2
    const expected: SessionCredits = { total: 3, unit: "credit", present: true }
    expect(sidebar()!.credits()).toEqual(expected)
    expect(sidebar()!.kind).toBe("credits-box")
    // assembly never forces a durable sync (explicit-refresh fallback only)
    expect(mock.sync).not.toHaveBeenCalled()
    // session-less props contribute nothing (both surfaces; on the footer chip
    // sessionID is optional in PromptFooterInput — absent means withheld, not a crash)
    expect(renderSidebar(mock, {})()).toBeNull()
    expect((renderSlot(mock, "prompt.footer.status", { mode: "normal" }) as () => unknown)()).toBeNull()
    await cleanup()
  })
})

describe("footer chip claim (prompt.footer.status)", () => {
  const chipAccessor = (mock: MockTuiContext, props: Record<string, unknown>): (() => FakeDomNode | null) =>
    renderSlot(mock, "prompt.footer.status", props) as () => FakeDomNode | null

  test("chip renders one single-line non-shrinking text node carrying credits + unit", async () => {
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 1.5, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    const chip = chipAccessor(mock, { sessionID: "sess", mode: "normal" })()

    expect(chip).not.toBeNull()
    // real chip view against the fake renderer: one <text> node, hard-bounded to a
    // single row, whose content accessor yields the formatted rollup. flexShrink 0
    // keeps the short credits string intact in the footer row — the host status box
    // beside it is the shrinkable one.
    expect(chip!.tag).toBe("text")
    expect(chip!.props.height).toBe(1)
    expect(chip!.props.wrapMode).toBe("none")
    expect(chip!.props.flexShrink).toBe(0)
    expect(chip!.children).toHaveLength(1)
    const content = chip!.children[0] as () => string
    expect(content()).toBe("1.5 credits")
    expect(content()).not.toContain("\n")
    await cleanup()
  })

  test("chip collapses to empty for credit-less sessions", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "plain" }] }] },
    })
    const cleanup = await setupPlugin(mock)

    // no credit state anywhere: tui.ts withholds the node entirely
    expect(chipAccessor(mock, { sessionID: "sess", mode: "normal" })()).toBeNull()
    await cleanup()
  })

  test("optional sessionID: absent sessionID withholds the chip (PromptFooterInput shape)", async () => {
    // `prompt.footer.status` props are `{ sessionID?: string; mode: "normal" | "shell" }`
    // — unlike the sidebar, sessionID may legitimately be absent (home/no-session
    // footer). The chip is withheld, never crashed.
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 2, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    expect(chipAccessor(mock, { mode: "normal" })()).toBeNull()
    expect(chipAccessor(mock, { mode: "shell" })()).toBeNull()
    // empty-string sessionID is also "no session"
    expect(chipAccessor(mock, { sessionID: "", mode: "normal" })()).toBeNull()
    await cleanup()
  })

  test("mode behavior: chip renders identically in normal and shell modes (mode ignored)", async () => {
    // Decision (documented in tui.ts): the chip renders in both modes — the host's
    // footer children don't change by mode, and collapsing on shell toggle would
    // only cause a layout jump.
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 3, creditsUnit: "credit" })] }],
      },
    })
    const cleanup = await setupPlugin(mock)

    for (const mode of ["normal", "shell"] as const) {
      const chip = chipAccessor(mock, { sessionID: "sess", mode })()
      expect(chip).not.toBeNull()
      expect((chip!.children[0] as () => string)()).toBe("3 credits")
    }
    await cleanup()
  })
})

describe("credits carried by the reasoning-ended event", () => {
  const chipText = (mock: MockTuiContext): string | null => {
    const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
    return chip === null ? null : (chip.children[0] as () => string)()
  }

  /**
   * The box view is mocked file-wide as the setup seam; the real view is loaded here against
   * the fake renderer and fed the accessor the sidebar claim assembled, so the rendered lines
   * are checked against the same data the host would render.
   */
  const boxLines = async (mock: MockTuiContext): Promise<string[]> => {
    const { createCreditsBoxView } = await vi.importActual<typeof import("../src/tui/credits-box-view")>(
      "../src/tui/credits-box-view.js",
    )
    const marker = renderSidebar(mock, { sessionID: "sess" })()
    expect(marker).not.toBeNull()
    const root = createCreditsBoxView(marker!.credits) as unknown as FakeDomNode
    return root.children.map((line) => {
      const node = line as FakeDomNode
      // the header wraps its content in a <b> node; plain lines carry the accessor directly
      const content = node.children[0]
      const accessor = typeof content === "function" ? content : (content as FakeDomNode).children[0]
      return (accessor as () => string)()
    })
  }

  test("credits carried only by the reasoning-ended event are recorded and rendered", async () => {
    // a stall notice still open at turn end: the SDK closes that reasoning part with the
    // credits and no text-ended event carries them
    const mock = makeTuiContext({
      messages: {
        sess: [{ id: "msg_1", type: "assistant", content: [{ type: "reasoning", text: "Kiro: no output for 30s" }, { type: "text", text: "answer" }] }],
      },
    })
    const cleanup = await setupPlugin(mock)
    expect(chipText(mock)).toBeNull() // nothing recorded yet
    const reasoningEnded = mock.listeners.find((listener) => listener.event === "session.reasoning.ended")
    expect(reasoningEnded).toBeDefined()

    reasoningEnded!.handler({
      data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 2, creditsUnit: "credit" } },
    })

    expect(chipText(mock)).toBe("2 credits")
    // box: header and total only
    expect(await boxLines(mock)).toEqual(["Kiro", "2 credits"])
    await cleanup()
  })
})

// ---------------------------------------------------------------------------
// logout dialog: the `integration.updated` watcher over the kiroLoggedOut flag
// ---------------------------------------------------------------------------

/** kiro integration fixture carrying the given stage (or no flag) and connections */
const kiroIntegration = (
  stage: "suspected" | "confirmed" | undefined,
  connections: LogoutIntegration["connections"] = [{ type: "credential", id: "cred-1" }],
): LogoutIntegration => ({
  id: "kiro",
  ...(stage === undefined ? {} : { metadata: { kiroLoggedOut: { stage } } }),
  connections,
})

const TWO_CREDENTIALS: LogoutIntegration["connections"] = [
  { type: "credential", id: "cred-1" },
  { type: "env", id: "env-1" },
  { type: "credential", id: "cred-2" },
]

const LOCATION: LogoutLocation = { directory: "/work/project", workspaceID: "ws-main" }

/** let the watcher's promise chains (invalidate -> sync -> list -> dialog/removal -> dispatch) settle */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** watcher over a standalone logout context; `answer(value)` resolves the open dialog */
const makeWatcher = (options: { location?: LogoutLocation } = { location: LOCATION }) => {
  const location = options.location
  const surfaces = makeLogoutSurfaces()
  const answers: Array<(value: boolean | undefined) => void> = []
  surfaces.confirm.mockImplementation(
    () =>
      new Promise<boolean | undefined>((resolve) => {
        answers.push(resolve)
      }),
  )
  const context = {
    location,
    client: { credential: { remove: surfaces.remove } },
    data: {
      location: {
        integration: {
          invalidate: surfaces.integrationInvalidate,
          sync: surfaces.integrationSync,
          list: surfaces.integrationList,
        },
      },
    },
    ui: { dialog: { confirm: surfaces.confirm } },
    keymap: { dispatch: surfaces.dispatch },
  }
  const watcher = createLogoutWatcher(context)
  return {
    ...surfaces,
    watcher,
    /** publish one update for the given stage/connections and settle */
    update: async (
      stage: "suspected" | "confirmed" | undefined,
      connections?: LogoutIntegration["connections"],
      event: { location?: LogoutLocation } = {},
    ): Promise<void> => {
      surfaces.setIntegrations([kiroIntegration(stage, connections)])
      watcher.handle(event)
      await settle()
    },
    /** answer the oldest open dialog and settle */
    answer: async (value: boolean | undefined): Promise<void> => {
      const resolve = answers.shift()
      if (resolve === undefined) throw new Error("no dialog open to answer")
      resolve(value)
      await settle()
    },
    openDialogs: () => answers.length,
  }
}

/** Each processed update invalidates its resolved location before the matching sync. */
const expectIntegrationRefreshes = (surfaces: LogoutSurfaces, locations: Array<LogoutLocation | undefined>): void => {
  const calls = locations.map((location) => [location])
  expect(surfaces.integrationInvalidate.mock.calls).toEqual(calls)
  expect(surfaces.integrationSync.mock.calls).toEqual(calls)
  for (const [index] of locations.entries()) {
    expect(surfaces.integrationInvalidate.mock.invocationCallOrder[index]).toBeLessThan(
      surfaces.integrationSync.mock.invocationCallOrder[index]!,
    )
    if (index > 0) {
      expect(surfaces.integrationInvalidate.mock.invocationCallOrder[index]).toBeGreaterThan(
        surfaces.integrationSync.mock.invocationCallOrder[index - 1]!,
      )
    }
  }
}

describe("logout watcher: reading the flag", () => {
  test("readLogoutStage reads only the kiro integration's staged flag", () => {
    expect(readLogoutStage([kiroIntegration("suspected")])).toBe("suspected")
    expect(readLogoutStage([kiroIntegration("confirmed")])).toBe("confirmed")
    expect(readLogoutStage([kiroIntegration(undefined)])).toBeUndefined()
    expect(readLogoutStage(undefined)).toBeUndefined()
    expect(readLogoutStage([])).toBeUndefined()
    // other integrations carrying the key are not kiro
    expect(readLogoutStage([{ id: "other", metadata: { kiroLoggedOut: { stage: "confirmed" } }, connections: [] }])).toBeUndefined()
    // unknown shapes read as "not logged out"
    expect(readLogoutStage([{ id: "kiro", metadata: { kiroLoggedOut: true }, connections: [] }])).toBeUndefined()
    expect(readLogoutStage([{ id: "kiro", metadata: { kiroLoggedOut: { stage: "weird" } }, connections: [] }])).toBeUndefined()
    expect(readLogoutStage([{ id: "kiro", metadata: { kiroLoggedOut: "suspected" }, connections: [] }])).toBeUndefined()
  })

  test("kiroCredentialIDs lists only credential connections with an id", () => {
    expect(kiroCredentialIDs([kiroIntegration("suspected", TWO_CREDENTIALS)])).toEqual(["cred-1", "cred-2"])
    expect(kiroCredentialIDs([kiroIntegration("suspected", [{ type: "credential" }, { type: "env", id: "e" }])])).toEqual([])
    expect(kiroCredentialIDs([{ id: "other", connections: [{ type: "credential", id: "x" }] }])).toEqual([])
    expect(kiroCredentialIDs(undefined)).toEqual([])
  })

})

describe("logout watcher: suspected stage", () => {
  test("shows the confirm dialog once, with the documented title and message, after syncing", async () => {
    const w = makeWatcher()

    await w.update("suspected")

    expect(w.integrationSync).toHaveBeenCalledTimes(1)
    expect(w.integrationSync).toHaveBeenCalledWith(LOCATION)
    expectIntegrationRefreshes(w, [LOCATION])
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.confirm).toHaveBeenCalledWith({ title: LOGOUT_DIALOG_TITLE, message: LOGOUT_DIALOG_MESSAGE })
    expect(LOGOUT_DIALOG_TITLE).toBe("Kiro CLI is logged out")
    expect(LOGOUT_DIALOG_MESSAGE).toBe("Reconnect now?")
    // nothing destructive before the user answers
    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("repeated suspected updates never re-prompt within the episode", async () => {
    const w = makeWatcher()

    await w.update("suspected")
    await w.update("suspected")
    await w.update("suspected")

    expect(w.integrationSync).toHaveBeenCalledTimes(3)
    expectIntegrationRefreshes(w, [LOCATION, LOCATION, LOCATION])
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("confirm removes every kiro credential connection by id only, then opens connect", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)

    await w.answer(true)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.remove).toHaveBeenNthCalledWith(1, {
      credentialID: "cred-1",
    })
    expect(w.remove).toHaveBeenNthCalledWith(2, {
      credentialID: "cred-2",
    })
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledWith(PROVIDER_CONNECT_COMMAND)
    expect(PROVIDER_CONNECT_COMMAND).toBe("provider.connect")
    // removals finish before the connect dialog opens
    const lastRemoval = Math.max(...w.remove.mock.invocationCallOrder)
    expect(w.dispatch.mock.invocationCallOrder[0]).toBeGreaterThan(lastRemoval)
  })

  test("confirm with no credential connections left still opens connect", async () => {
    const w = makeWatcher()
    await w.update("suspected", [{ type: "env", id: "env-1" }])

    await w.answer(true)

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).toHaveBeenCalledWith(PROVIDER_CONNECT_COMMAND)
  })

  test("cancel does nothing", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)

    await w.answer(false)

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    // and the episode stays answered: no second prompt on the next resync
    await w.update("suspected", TWO_CREDENTIALS)
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("a dismissed dialog (undefined) counts as cancel", async () => {
    const w = makeWatcher()
    await w.update("suspected")

    await w.answer(undefined)

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("the event location wins over the context location for integration invalidate, sync and list", async () => {
    const w = makeWatcher()
    const eventLocation: LogoutLocation = { directory: "/other" }

    await w.update("suspected", undefined, { location: eventLocation })
    await w.answer(true)

    expect(w.integrationSync).toHaveBeenCalledWith(eventLocation)
    expectIntegrationRefreshes(w, [eventLocation])
    expect(w.integrationList).toHaveBeenCalledWith(eventLocation)
    expect(w.remove).toHaveBeenCalledWith({ credentialID: "cred-1" })
  })

  test("without any location the removal request carries only the credential id", async () => {
    const w = makeWatcher({})

    await w.update("suspected")
    await w.answer(true)

    expect(w.integrationSync).toHaveBeenCalledWith(undefined)
    expectIntegrationRefreshes(w, [undefined])
    expect(w.remove).toHaveBeenCalledWith({ credentialID: "cred-1" })
    expect(w.dispatch).toHaveBeenCalledWith(PROVIDER_CONNECT_COMMAND)
  })
})

describe("logout watcher: confirmed stage", () => {
  test("an unlocated update refreshes a cached logged-in integration before reading the confirmed flag", async () => {
    const w = makeWatcher()
    let invalidated = false
    w.setIntegrations([kiroIntegration(undefined)])
    w.integrationInvalidate.mockImplementation(() => {
      invalidated = true
    })
    w.integrationSync.mockImplementation(async () => {
      // Like the host, a loaded collection's sync is a no-op until invalidated.
      if (!invalidated) return
      w.setIntegrations([kiroIntegration("confirmed")])
      invalidated = false
    })

    w.watcher.handle({})
    await settle()

    expectIntegrationRefreshes(w, [LOCATION])
    expect(w.integrationList.mock.invocationCallOrder[0]).toBeGreaterThan(
      w.integrationSync.mock.invocationCallOrder[0]!,
    )
    expect(w.remove).toHaveBeenCalledWith({ credentialID: "cred-1" })
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("removes the credential connections once and shows the dialog when it was not shown yet", async () => {
    const w = makeWatcher()

    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.remove.mock.calls).toEqual([[{ credentialID: "cred-1" }], [{ credentialID: "cred-2" }]])
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("repeated confirmed updates neither remove again nor re-prompt", async () => {
    const w = makeWatcher()

    await w.update("confirmed", TWO_CREDENTIALS)
    await w.update("confirmed", TWO_CREDENTIALS)
    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("suspected then confirmed: the open dialog is not shown again and removal happens once", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.openDialogs()).toBe(1)

    // the follow-up probe confirmed while the dialog is still open
    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.remove).toHaveBeenCalledTimes(2)

    // the user then confirms: no second removal, just the connect dialog
    await w.answer(true)
    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  test("confirm after an automatic removal does not remove again", async () => {
    const w = makeWatcher()
    await w.update("confirmed", TWO_CREDENTIALS)
    expect(w.remove).toHaveBeenCalledTimes(2)

    await w.answer(true)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  test("confirmed after a confirmed suspected dialog removes nothing further", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)
    await w.answer(true)
    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.dispatch).toHaveBeenCalledTimes(1)

    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.confirm).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })
})

describe("logout watcher: episodes and re-arming", () => {
  test("an update without the flag ends the episode; the next suspected prompts again", async () => {
    const w = makeWatcher()
    await w.update("suspected")
    await w.answer(false)
    expect(w.confirm).toHaveBeenCalledTimes(1)

    await w.update(undefined)
    await w.update("suspected")

    expect(w.confirm).toHaveBeenCalledTimes(2)
  })

  test("a new episode after confirmed removes again", async () => {
    const w = makeWatcher()
    await w.update("confirmed")
    expect(w.remove).toHaveBeenCalledTimes(1)

    await w.update(undefined)
    await w.update("confirmed")

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.confirm).toHaveBeenCalledTimes(2)
  })

  test("a confirm that arrives after the episode ended is ignored", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)
    expect(w.openDialogs()).toBe(1)

    // kiro-cli logged back in before the user answered
    await w.update(undefined, TWO_CREDENTIALS)
    await w.answer(true)

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("a confirm that arrives after dispose is ignored, and disposed watchers drop updates", async () => {
    const w = makeWatcher()
    await w.update("suspected", TWO_CREDENTIALS)

    w.watcher.dispose()
    await w.answer(true)
    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(w.integrationSync).toHaveBeenCalledTimes(1)
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("dispose while the sync is in flight stops the update before it reads the flag", async () => {
    const w = makeWatcher()
    let releaseSync!: () => void
    w.integrationSync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSync = resolve
        }),
    )
    w.setIntegrations([kiroIntegration("confirmed")])
    w.watcher.handle({})
    await settle()

    w.watcher.dispose()
    releaseSync()
    await settle()

    expect(w.integrationList).not.toHaveBeenCalled()
    expect(w.remove).not.toHaveBeenCalled()
    expect(w.confirm).not.toHaveBeenCalled()
  })

  test("episodes are tracked per location", async () => {
    const w = makeWatcher()
    const other: LogoutLocation = { directory: "/elsewhere" }

    await w.update("suspected")
    await w.update("suspected", undefined, { location: other })

    expect(w.confirm).toHaveBeenCalledTimes(2)
  })
})

describe("logout watcher: failures and unrelated updates", () => {
  test("a throwing invalidate never throws and later updates still work", async () => {
    const w = makeWatcher()
    w.integrationInvalidate.mockImplementationOnce(() => {
      throw new Error("invalidate failed")
    })

    expect(() => w.watcher.handle({})).not.toThrow()
    await settle()
    expect(w.integrationSync).not.toHaveBeenCalled()
    expect(w.confirm).not.toHaveBeenCalled()

    await w.update("suspected")
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("a rejecting sync never throws and later updates still work", async () => {
    const w = makeWatcher()
    w.integrationSync.mockRejectedValueOnce(new Error("sync failed"))

    expect(() => w.watcher.handle({})).not.toThrow()
    await settle()
    expect(w.confirm).not.toHaveBeenCalled()

    await w.update("suspected")
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("a throwing list never throws and later updates still work", async () => {
    const w = makeWatcher()
    w.integrationList.mockImplementationOnce(() => {
      throw new Error("list failed")
    })

    expect(() => w.watcher.handle({})).not.toThrow()
    await settle()
    expect(w.confirm).not.toHaveBeenCalled()

    await w.update("suspected")
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("a rejecting credential removal is skipped; the others proceed and connect still opens", async () => {
    const w = makeWatcher()
    w.remove.mockRejectedValueOnce(new Error("remove failed"))
    await w.update("suspected", TWO_CREDENTIALS)

    await w.answer(true)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  test("a rejecting dialog never throws and does not remove anything", async () => {
    const w = makeWatcher()
    w.confirm.mockRejectedValueOnce(new Error("dialog failed"))

    await w.update("suspected")

    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("a throwing dispatch never throws after the removal", async () => {
    const w = makeWatcher()
    w.dispatch.mockImplementationOnce(() => {
      throw new Error("dispatch failed")
    })
    await w.update("suspected")

    await w.answer(true)

    expect(w.remove).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  test("a rejecting removal in the confirmed stage still leaves the dialog path working", async () => {
    const w = makeWatcher()
    w.remove.mockRejectedValue(new Error("remove failed"))

    await w.update("confirmed", TWO_CREDENTIALS)

    expect(w.remove).toHaveBeenCalledTimes(2)
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })

  test("updates for other integrations or without kiro do nothing", async () => {
    const w = makeWatcher()

    w.setIntegrations([{ id: "other", metadata: { kiroLoggedOut: { stage: "confirmed" } }, connections: [{ type: "credential", id: "x" }] }])
    w.watcher.handle({})
    await settle()
    w.setIntegrations(undefined)
    w.watcher.handle({})
    await settle()
    w.setIntegrations([])
    w.watcher.handle({})
    await settle()

    expect(w.integrationSync).toHaveBeenCalledTimes(3)
    expect(w.confirm).not.toHaveBeenCalled()
    expect(w.remove).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  test("a malformed event payload is treated like an update for the context location", async () => {
    const w = makeWatcher()
    w.setIntegrations([kiroIntegration("suspected")])

    expect(() => w.watcher.handle(undefined as never)).not.toThrow()
    await settle()

    expect(w.integrationSync).toHaveBeenCalledWith(LOCATION)
    expect(w.confirm).toHaveBeenCalledTimes(1)
  })
})

describe("logout watcher: wiring through tui setup", () => {
  test.each([
    { source: "event", event: { location: { directory: "/other" } }, resolvedLocation: { directory: "/other" } },
    { source: "context fallback", event: {}, resolvedLocation: LOCATION },
  ])("the integration.updated listener refreshes by $source location, prompts and removes by credential id only", async ({ event, resolvedLocation }) => {
    const mock = makeTuiContext({ withLogout: { location: LOCATION } })
    const logout = mock.logout!
    logout.confirm.mockResolvedValue(true)
    logout.setIntegrations([kiroIntegration("suspected", TWO_CREDENTIALS)])
    const cleanup = await setupPlugin(mock)
    const listener = mock.listeners.find((entry) => entry.event === "integration.updated")
    expect(listener).toBeDefined()

    listener!.handler(event)
    await settle()

    expectIntegrationRefreshes(logout, [resolvedLocation])
    expect(logout.confirm).toHaveBeenCalledTimes(1)
    expect(logout.confirm).toHaveBeenCalledWith({ title: LOGOUT_DIALOG_TITLE, message: LOGOUT_DIALOG_MESSAGE })
    expect(logout.remove).toHaveBeenCalledTimes(2)
    expect(logout.remove.mock.calls).toEqual([[{ credentialID: "cred-1" }], [{ credentialID: "cred-2" }]])
    expect(logout.dispatch).toHaveBeenCalledWith(PROVIDER_CONNECT_COMMAND)

    await cleanup()
    expect(listener!.unsubscribeCalls).toBe(1)
  })

  test("after cleanup the listener's handler drops updates", async () => {
    const mock = makeTuiContext({ withLogout: { location: LOCATION } })
    const logout = mock.logout!
    logout.setIntegrations([kiroIntegration("confirmed", TWO_CREDENTIALS)])
    const cleanup = await setupPlugin(mock)
    const listener = mock.listeners.find((entry) => entry.event === "integration.updated")!

    await cleanup()
    listener.handler({})
    await settle()

    expect(logout.integrationInvalidate).not.toHaveBeenCalled()
    expect(logout.integrationSync).not.toHaveBeenCalled()
    expect(logout.remove).not.toHaveBeenCalled()
    expect(logout.confirm).not.toHaveBeenCalled()
  })
})

describe("theme feature detection", () => {
  const THEME = { text: { base: "#e0e0e0", muted: "#808080" } }
  const KIRO_MESSAGES: Record<string, ReadonlyArray<FixtureMessage>> = {
    sess: [{ id: "msg_1", type: "assistant", content: [statePart("text", { credits: 2, creditsUnit: "credit" })] }],
  }

  test("context.theme tokens flow into both views when present", async () => {
    const mock = makeTuiContext({ messages: KIRO_MESSAGES, theme: THEME })
    const cleanup = await setupPlugin(mock)

    const box = renderSidebar(mock, { sessionID: "sess" })()
    expect(box!.tokens).toEqual({ default: "#e0e0e0", subdued: "#808080" })

    const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
    expect(chip!.props.fg).toBe("#808080") // chip stays subdued beside the host status text
    await cleanup()
  })

  test("absent or misshapen theme falls back to default styling without throwing", async () => {
    // rendering never depends on the theme: no theme and junk themes
    // behave identically — no tokens, no fg, no throw
    for (const theme of [
      undefined,
      null,
      42,
      "dark",
      {},
      { text: null },
      { text: { base: "", muted: 7 } },
      { text: { default: "#e0e0e0", subdued: "#808080" } },
    ]) {
      const mock = makeTuiContext({ messages: KIRO_MESSAGES, ...(theme !== undefined ? { theme } : {}) })
      const cleanup = await setupPlugin(mock)

      const box = renderSidebar(mock, { sessionID: "sess" })()
      expect(box!.tokens).toBeUndefined()

      const chip = (renderSlot(mock, "prompt.footer.status", { sessionID: "sess", mode: "normal" }) as () => FakeDomNode | null)()
      expect(chip).not.toBeNull()
      expect("fg" in chip!.props).toBe(false)
      await cleanup()
    }
  })
})

describe("storage.memory feature detection", () => {
  test("memory-backed store is keyed 'transient-credits' and survives cleanup by design", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
      withMemoryStorage: true,
    })
    const cleanup = await setupPlugin(mock)
    expect(mock.context.storage!.memory).toHaveBeenCalledTimes(1)
    expect(mock.context.storage!.memory).toHaveBeenCalledWith("transient-credits", expect.objectContaining({ initial: expect.anything() }))

    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5)

    await cleanup()

    // the memory store is shared with the next plugin generation (hot reload),
    // so cleanup must not clear it — a fresh setup on the same storage still
    // sees the recorded transient credits
    const rerun = await setupPlugin(mock)
    expect(renderSidebar(mock, { sessionID: "sess" })!()!.credits().total).toBe(5)
    await rerun()
  })

  test("fallback per-setup store (no storage.memory) still clears on cleanup", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5)

    await cleanup()

    expect(credits()).toBeNull() // per-setup store emptied on cleanup
  })
})

describe("tui cleanup", () => {
  test("cleanup disposes both claims and the listener, clears the store, aggregates failures, and is idempotent", async () => {
    const mock = makeTuiContext({
      messages: { sess: [{ id: "msg_1", type: "assistant", content: [{ type: "text", text: "live" }] }] },
      failUnregisterOf: "sidebar.content",
    })
    const cleanup = await setupPlugin(mock)
    const handler = mock.listeners[0]!.handler
    handler({ data: { sessionID: "sess", assistantMessageID: "msg_1", ordinal: 0, state: { credits: 5, creditsUnit: "credit" } } })
    const credits = renderSidebar(mock, { sessionID: "sess" })
    expect(credits()!.credits().total).toBe(5) // transient state present before cleanup

    // one claim's disposer throws: every other disposer still runs, failures aggregate
    await expect(cleanup()).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
    )

    // both claims (sidebar box + footer chip) unregistered exactly once
    expect(mock.slots).toHaveLength(2)
    for (const slot of mock.slots) expect(slot.unregisterCalls).toBe(1)
    expect(mock.listeners[0]!.unsubscribeCalls).toBe(1)
    // the store's clear disposer ran despite the claim failure
    expect(credits()).toBeNull()

    // second call is a no-op: resolves, and no disposer runs twice
    await expect(cleanup()).resolves.toBeUndefined()
    for (const slot of mock.slots) expect(slot.unregisterCalls).toBe(1)
    expect(mock.listeners[0]!.unsubscribeCalls).toBe(1)
  })
})

describe("dist/tui.js module isolation", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  /**
   * Import the built module via a runtime URL so tsc never resolves dist/. The
   * import succeeding under plain Node is the lazy-@opentui/core contract: the
   * Bun-native TUI runtime only loads when the host runs setup().
   */
  const importDist = (name: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(join(ROOT, "dist", name)).href) as Promise<Record<string, unknown>>

  test("dist/tui.js loads under plain Node with the { id, setup } shape", async () => {
    const mod = await importDist("tui.js")

    const plugin = mod.default as Record<string, unknown>
    expect(Object.keys(plugin).sort()).toEqual(["id", "setup"])
    expect(plugin.id).toBe("opencode-kiro")
    expect(typeof plugin.setup).toBe("function")
    expect("server" in mod).toBe(false)
  })
})
