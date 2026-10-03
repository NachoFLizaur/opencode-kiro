import { describe, expect, test } from "vitest"
import type { CreditPart } from "../src/tui/credits"
import {
  clear,
  createTransientStore,
  mergedMessageCredits,
  reconcile,
  recordTextEnded,
  type DurableMessage,
  type TextEndedEvent,
} from "../src/tui/transient-credits"

// Transient text-ended store tests. The store works around the live TUI
// reducer (session.text.ended drops event.data.state) and must uphold two
// invariants:
//   - durable part state is authoritative: transient and durable values are
//     never summed for one message, and
//   - reconciliation deletes superseded/orphaned (sessionID, assistantMessageID,
//     ordinal) tuples without ever changing the displayed total.

/** Part-shaped fixture carrying key-unwrapped credit state. */
const statePart = (type: "text" | "reasoning", state: Record<string, unknown>): CreditPart => ({ type, state })

/** Durable assistant message with inlined content parts (SessionMessageInfo shape). */
const assistant = (id: string, content: ReadonlyArray<CreditPart> = []): DurableMessage => ({
  id,
  type: "assistant",
  content,
})

/** `session.text.ended` fixture mirroring the exported TextEndedEvent shape. */
const textEnded = (
  sessionID: string,
  assistantMessageID: string,
  ordinal: number,
  state?: object,
): TextEndedEvent => ({
  data: { sessionID, assistantMessageID, ordinal, ...(state !== undefined ? { state } : {}) },
})

describe("recordTextEnded", () => {
  test("records valid text-ended credit state by (sessionID, assistantMessageID, ordinal) tuple", () => {
    const store = createTransientStore()

    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 1.5, creditsUnit: "credit" }))

    expect(store.entries.size).toBe(1)
    expect([...store.entries.values()]).toEqual([{ credits: 1.5, unit: "credit" }])

    // same tuple overwrites (no duplicate entry); a different ordinal is a new tuple
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 2, creditsUnit: "credit" }))
    expect(store.entries.size).toBe(1)
    expect([...store.entries.values()]).toEqual([{ credits: 2, unit: "credit" }])

    recordTextEnded(store, textEnded("sess", "msg_1", 1, { credits: 3, creditsUnit: "credit" }))
    expect(store.entries.size).toBe(2)
  })

  test("ignores events without valid credit state or tuple identifiers", () => {
    const store = createTransientStore()

    const invalid: TextEndedEvent[] = [
      textEnded("sess", "msg_1", 0), // no state at all
      textEnded("sess", "msg_1", 0, {}), // state without credits
      textEnded("sess", "msg_1", 0, { credits: Number.NaN }),
      textEnded("sess", "msg_1", 0, { credits: Number.POSITIVE_INFINITY }),
      textEnded("sess", "msg_1", 0, { credits: "7" } as object), // string credits
      textEnded("sess", "msg_1", 0, { kiro: { credits: 7 } }), // wrapped shape is forbidden
      textEnded("", "msg_1", 0, { credits: 1 }), // empty sessionID
      textEnded("sess", "", 0, { credits: 1 }), // empty assistantMessageID
      textEnded("sess", "msg_1", 1.5, { credits: 1 }), // non-integer ordinal
      textEnded("sess", "msg_1", -1, { credits: 1 }), // negative ordinal
      { data: null } as unknown as TextEndedEvent,
      {} as TextEndedEvent,
    ]

    const record = (): void => {
      for (const event of invalid) recordTextEnded(store, event)
    }

    expect(record).not.toThrow()
    expect(store.entries.size).toBe(0)
  })

  test("a status-only ended event records nothing; credits next to a status are kept as credits only", () => {
    const store = createTransientStore()
    const status = { stalledMs: 66_000, hint: "kind: ModelOverloadedError" }

    // the SDK's stall status rides the same state object, but only credits are transient data
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { status }))
    expect(store.entries.size).toBe(0)
    expect(mergedMessageCredits(store, "sess", [assistant("msg_1")])).toEqual({
      total: 0,
      unit: undefined,
      present: false,
    })

    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 2, creditsUnit: "credit", status }))
    expect([...store.entries.values()]).toEqual([{ credits: 2, unit: "credit" }])
    expect(mergedMessageCredits(store, "sess", [assistant("msg_1")])).toEqual({ total: 2, unit: "credit", present: true })
  })
})

describe("mergedMessageCredits", () => {
  test("text-only live: merged total uses the transient value when durable has no state", () => {
    // the live reducer bug: durable-in-TUI text part exists but carries no state yet
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 5, creditsUnit: "credit" }))
    const durable = [assistant("msg_1", [{ type: "text", text: "hello" }])]

    const result = mergedMessageCredits(store, "sess", durable)

    expect(result).toEqual({ total: 5, unit: "credit", present: true })
  })

  test("highest ordinal wins among transient tuples of one message (never summed)", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 5, creditsUnit: "credit" }))
    recordTextEnded(store, textEnded("sess", "msg_1", 2, { credits: 7, creditsUnit: "credit" }))

    const result = mergedMessageCredits(store, "sess", [assistant("msg_1")])

    expect(result.total).toBe(7) // not 12: one carrier per message
  })

  test("durable state is authoritative over transient; values are never summed", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 9, creditsUnit: "credit" }))
    const durable = [assistant("msg_1", [statePart("text", { credits: 3, creditsUnit: "credit" })])]

    const result = mergedMessageCredits(store, "sess", durable)

    expect(result.total).toBe(3) // durable wins
    expect(result.total).not.toBe(12) // and is never added to the transient 9
  })

  test("reasoning-live durable state + transient text tuple for the same message counts once", () => {
    // dual-carrier: the reasoning reducer branch does copy state live, while the
    // text carrier arrives only via the transient workaround
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 1, { credits: 4, creditsUnit: "credit" }))
    const durable = [assistant("msg_1", [statePart("reasoning", { credits: 4, creditsUnit: "credit" })])]

    const result = mergedMessageCredits(store, "sess", durable)

    expect(result).toEqual({ total: 4, unit: "credit", present: true }) // not 8
  })

  test("multi-message session sums exactly one value per assistant message", () => {
    const store = createTransientStore()
    // msg_2 is transient-only; msg_3 is dual-carrier (durable reasoning + transient text)
    recordTextEnded(store, textEnded("sess", "msg_2", 0, { credits: 2, creditsUnit: "credit" }))
    recordTextEnded(store, textEnded("sess", "msg_3", 1, { credits: 3.5, creditsUnit: "credit" }))
    // a tuple whose message is absent from the durable list never counts
    recordTextEnded(store, textEnded("sess", "msg_ghost", 0, { credits: 100, creditsUnit: "credit" }))
    const durable: DurableMessage[] = [
      { id: "msg_user", type: "user", content: [statePart("text", { credits: 50, creditsUnit: "credit" })] },
      assistant("msg_1", [statePart("text", { credits: 1, creditsUnit: "credit" })]),
      assistant("msg_2", [{ type: "text", text: "live text, no state" }]),
      assistant("msg_3", [statePart("reasoning", { credits: 3.5, creditsUnit: "credit" })]),
    ]

    const result = mergedMessageCredits(store, "sess", durable)

    expect(result).toEqual({ total: 6.5, unit: "credit", present: true }) // 1 + 2 + 3.5
  })

  test("empty store and state-less durable messages report absent credits", () => {
    const store = createTransientStore()

    const result = mergedMessageCredits(store, "sess", [assistant("msg_1", [{ type: "text", text: "plain" }])])

    expect(result).toEqual({ total: 0, unit: undefined, present: false })
  })
})

describe("reconcile", () => {
  test("deletes tuples superseded by durable state without changing the total", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 3, creditsUnit: "credit" }))
    const durable = [assistant("msg_1", [statePart("text", { credits: 3, creditsUnit: "credit" })])]
    const before = mergedMessageCredits(store, "sess", durable)

    reconcile(store, "sess", durable)

    expect(store.entries.size).toBe(0) // superseded tuple deleted
    const after = mergedMessageCredits(store, "sess", durable)
    expect(after).toEqual(before) // reconciliation never changes displayed totals
    expect(after.total).toBe(3)
  })

  test("keeps tuples whose durable message still lacks credit state", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 5, creditsUnit: "credit" }))
    const durable = [assistant("msg_1", [{ type: "text", text: "no state yet" }])]
    const before = mergedMessageCredits(store, "sess", durable)

    reconcile(store, "sess", durable)

    expect(store.entries.size).toBe(1) // still the only credit carrier
    expect(mergedMessageCredits(store, "sess", durable)).toEqual(before)
    expect(before.total).toBe(5)
  })

  test("drops orphaned tuples of deleted messages and sessions, scoped to the given session", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_gone", 0, { credits: 1 }))
    recordTextEnded(store, textEnded("sess", "msg_live", 0, { credits: 2 }))
    recordTextEnded(store, textEnded("sess_other", "msg_a", 0, { credits: 3 }))

    // msg_gone no longer exists in durable data -> GC'd; other session untouched
    reconcile(store, "sess", [assistant("msg_live")])
    expect(store.entries.size).toBe(2)
    expect(mergedMessageCredits(store, "sess", [assistant("msg_live")]).total).toBe(2)
    expect(mergedMessageCredits(store, "sess_other", [assistant("msg_a")]).total).toBe(3)

    // whole session deleted: caller passes an empty durable list for it
    reconcile(store, "sess_other", [])
    expect(store.entries.size).toBe(1)
    expect(mergedMessageCredits(store, "sess", [assistant("msg_live")]).total).toBe(2)
  })
})

describe("clear", () => {
  test("empties the store", () => {
    const store = createTransientStore()
    recordTextEnded(store, textEnded("sess", "msg_1", 0, { credits: 5, creditsUnit: "credit" }))
    recordTextEnded(store, textEnded("sess_other", "msg_2", 1, { credits: 6 }))
    expect(store.entries.size).toBe(2)

    clear(store)

    expect(store.entries.size).toBe(0)
    expect(mergedMessageCredits(store, "sess", [assistant("msg_1")])).toEqual({
      total: 0,
      unit: undefined,
      present: false,
    })
  })
})
