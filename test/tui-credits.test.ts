import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import {
  creditsForMessage,
  formatCredits,
  messageCredits,
  readPartCredits,
  sumSessionCredits,
  type CreditMessage,
  type CreditPart,
} from "../src/tui/credits"

// TUI credit-helper tests (task 09, for task 08). The helpers are pure by
// design — no opentui runtime, no plugin host, no mocks: fixtures are plain
// Part-shaped objects carrying `metadata` (SDK types.gen.ts TextPart:382-384,
// ReasoningPart:408-410 — the plugin API surfaces `metadata`, never
// `providerMetadata`).
//
// Core hazard under test: DUAL EMISSION — one assistant message carries the
// SAME turn total on both its final text part and its reasoning part, so
// credits must count ONCE PER MESSAGE (last carrier wins, never summed).

/** Part-shaped fixture carrying `{ kiro: ... }` metadata. */
const carrierPart = (type: "text" | "reasoning", kiro: Record<string, unknown>): CreditPart => ({
  type,
  metadata: { kiro },
})

const assistant = (id: string): CreditMessage => ({ id, role: "assistant" })

/** partsByMessage lookup over a plain fixture table. */
const lookup =
  (table: Record<string, ReadonlyArray<CreditPart>>) =>
  (messageID: string): ReadonlyArray<CreditPart> =>
    table[messageID] ?? []

describe("credit dedupe per message", () => {
  test("dual emission counted once per message", () => {
    // Reasoning + text parts of one message both carry the turn total (3).
    const parts = [
      carrierPart("reasoning", { credits: 3, creditsUnit: "credit" }),
      carrierPart("text", { credits: 3, creditsUnit: "credit" }),
    ]

    const credits = creditsForMessage(parts)

    expect(credits).toBe(3) // NOT 6 — carriers are never summed within a message
  })

  test("last carrier wins within a message; unit backfills from part order", () => {
    // Differing carrier values prove the rule is last-wins, not max/sum: the
    // unit-less final carrier takes the credits while the unit falls back to
    // the most recent part that DID carry creditsUnit.
    const parts = [
      carrierPart("reasoning", { credits: 2, creditsUnit: "credit" }),
      carrierPart("text", { credits: 5 }),
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
      msg_user: [carrierPart("text", { credits: 100, creditsUnit: "credit" })],
      msg_1: [carrierPart("text", { credits: 1, creditsUnit: "credit" })],
      msg_2: [carrierPart("text", { credits: 2, creditsUnit: "credit" })],
      msg_3: [
        // Dual emission inside the rollup still counts once.
        carrierPart("reasoning", { credits: 3.5, creditsUnit: "credit" }),
        carrierPart("text", { credits: 3.5, creditsUnit: "credit" }),
      ],
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result).toEqual({ total: 6.5, unit: "credit" }) // 1 + 2 + 3.5
  })

  test("messages without metadata contribute 0", () => {
    // Mixed session: empty messages, metadata-less parts, malformed metadata,
    // and non-finite credits all contribute nothing — only the real carrier
    // counts and the total stays a finite number (no NaN propagation).
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3"), assistant("msg_4")]
    const partsByMessage = lookup({
      msg_1: [],
      msg_2: [{ type: "text", text: "plain" }, { type: "step-start" }],
      msg_3: [
        { type: "text", metadata: null },
        { type: "text", metadata: "not-an-object" }, // must not throw
        { type: "text", metadata: { kiro: "not-an-object" } },
        carrierPart("text", { credits: Number.NaN }),
        carrierPart("text", { credits: Number.POSITIVE_INFINITY }),
        carrierPart("text", { credits: "7" }), // string credits don't count
      ],
      msg_4: [carrierPart("text", { credits: 4 })],
    })

    const compute = (): ReturnType<typeof sumSessionCredits> => sumSessionCredits(messages, partsByMessage)

    expect(compute).not.toThrow()
    const result = compute()
    expect(result.total).toBe(4)
    expect(Number.isFinite(result.total)).toBe(true)
    expect(result.unit).toBeUndefined() // no carrier ever reported a unit
  })

  test("non-kiro metadata ignored", () => {
    // Key scoping: only `metadata.kiro` counts — other metadata namespaces
    // and the raw `providerMetadata` key (not surfaced by the plugin API)
    // contribute nothing.
    const otherNamespace: CreditPart = { type: "text", metadata: { other: { credits: 9, creditsUnit: "credit" } } }
    const wrongKey: CreditPart = { type: "text", providerMetadata: { kiro: { credits: 9 } } }

    expect(readPartCredits(otherNamespace)).toBeUndefined()
    expect(readPartCredits(wrongKey)).toBeUndefined()
    expect(creditsForMessage([otherNamespace, wrongKey])).toBeUndefined()
    const result = sumSessionCredits([assistant("msg_1")], () => [otherNamespace, wrongKey])
    expect(result).toEqual({ total: 0, unit: undefined })
  })

  test("unit taken from most recent carrier", () => {
    const messages = [assistant("msg_1"), assistant("msg_2"), assistant("msg_3")]
    const partsByMessage = lookup({
      msg_1: [carrierPart("text", { credits: 1, creditsUnit: "credits" })], // older unit
      msg_2: [carrierPart("text", { credits: 2, creditsUnit: "points" })], // newest unit
      msg_3: [carrierPart("text", { credits: 3 })], // unit-less carrier must not erase it
    })

    const result = sumSessionCredits(messages, partsByMessage)

    expect(result.unit).toBe("points")
    expect(result.total).toBe(6)
  })
})

describe("formatCredits", () => {
  test("formatCredits edge cases", () => {
    // kiro-cli reports the singular "credit"; pluralize only when the value
    // is not exactly 1 and the unit is not already s-terminated.
    expect(formatCredits(0, "credit")).toBe("0 credits")
    expect(formatCredits(0.5, "credit")).toBe("0.5 credits")
    expect(formatCredits(12, "credit")).toBe("12 credits")
    expect(formatCredits(12.5, "credit")).toBe("12.5 credits")
    expect(formatCredits(1, "credit")).toBe("1 credit") // singular preserved
    expect(formatCredits(2, "points")).toBe("2 points") // never "pointss"

    // No unit known yet → bare number; a unit string is never invented.
    expect(formatCredits(0)).toBe("0")
    expect(formatCredits(0.5)).toBe("0.5")
    expect(formatCredits(12)).toBe("12")
    for (const value of [0, 0.5, 12]) {
      expect(formatCredits(value)).not.toContain("undefined")
    }
  })
})

describe("dist/tui.js module isolation", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  /**
   * Import the built module via a runtime-computed file URL so `tsc --noEmit`
   * never tries to resolve `dist/` (gitignored, absent pre-build). The import
   * SUCCEEDING under plain node is itself the lazy-@opentui/core contract —
   * the Bun-native TUI runtime only loads inside `tui()`.
   */
  const importDist = (name: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(join(ROOT, "dist", name)).href) as Promise<Record<string, unknown>>

  test("tui module exports no server", async () => {
    // Namespace-level isolation (scaffold.test.ts already covers the DEFAULT
    // export's function-valued `tui` / absent `server`): the default carries
    // ONLY `tui`, no `server` named export exists anywhere, and the pure
    // helpers stay importable as named exports.
    const mod = await importDist("tui.js")

    expect("server" in mod).toBe(false)
    expect(Object.keys(mod.default as Record<string, unknown>)).toEqual(["tui"])
    const helpers = ["creditsForMessage", "formatCredits", "messageCredits", "readPartCredits", "sumSessionCredits"]
    for (const helper of helpers) {
      expect(typeof mod[helper]).toBe("function")
    }
  })
})
