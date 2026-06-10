// Pure credit-summing/formatting helpers for the Kiro sidebar context view.
//
// The Kiro SDK (kiro-acp-ai-provider, task 05) emits `{ kiro: { credits,
// creditsUnit } }` provider metadata on completed turns with known credits.
// opencode persists it on parts, and the TUI plugin API exposes it as
// `part.metadata` — NOT `providerMetadata` (SDK types.gen.ts TextPart:382-384,
// ReasoningPart:408-410: `metadata?: { [key: string]: unknown }`).
//
// Dual-emission hazard: one assistant message carries the SAME turn total on
// BOTH its final text part and its reasoning part (when the turn streamed
// reasoning). Credits MUST therefore be counted ONCE PER MESSAGE — carriers
// within a message are never summed; the last carrier wins.
//
// No `kiro` key at all (unknown credits, cancelled turns, mid-turn tool-call
// flushes, error paths) means "no credits info": the message contributes
// nothing and rendering degrades to a plain zero.
//
// This module is deliberately free of opentui/solid/plugin imports so task 09
// can unit-test it under plain node/vitest without a TUI harness.

/**
 * Any part-like object; credit metadata is read defensively from an optional
 * `metadata` record. Every SDK `Part` variant is assignable — including ones
 * with no `metadata` property at all (e.g. SubtaskPart), which simply
 * contribute nothing. (`object` rather than `{ metadata?: unknown }` because
 * TypeScript's weak-type check would reject metadata-less Part variants.)
 */
export type CreditPart = object

/** Minimal structural message shape — SDK `Message` is assignable. */
export interface CreditMessage {
  readonly id: string
  readonly role: string
}

/** One part's credit metadata: the turn total plus the SDK-reported unit. */
export interface PartCredits {
  credits: number
  unit?: string
}

/** Session-wide rollup. `unit` stays undefined until metadata reports one. */
export interface SessionCredits {
  total: number
  unit?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Read `{ kiro: { credits, creditsUnit } }` from one part's metadata.
 * Defensive on every level — metadata is untyped (`Record<string, unknown>`)
 * and only finite numeric credits count, mirroring the provider's own
 * `Number.isFinite` emission guard.
 */
export function readPartCredits(part: CreditPart): PartCredits | undefined {
  if (!isRecord(part)) return undefined
  const metadata = part.metadata
  if (!isRecord(metadata)) return undefined
  const kiro = metadata.kiro
  if (!isRecord(kiro)) return undefined
  if (typeof kiro.credits !== "number" || !Number.isFinite(kiro.credits)) return undefined
  return {
    credits: kiro.credits,
    unit: typeof kiro.creditsUnit === "string" && kiro.creditsUnit.length > 0 ? kiro.creditsUnit : undefined,
  }
}

/**
 * One message's turn total + unit, deduped across parts: text and reasoning
 * parts of the same message carry the SAME total (dual emission), so the LAST
 * carrier's credits win and carrier values are NEVER summed. The unit comes
 * from the most recent part carrying `creditsUnit`.
 */
export function messageCredits(parts: ReadonlyArray<CreditPart>): PartCredits | undefined {
  const carriers = parts.map(readPartCredits).filter((value): value is PartCredits => value !== undefined)
  const last = carriers.at(-1)
  if (!last) return undefined
  return {
    credits: last.credits,
    unit: last.unit ?? carriers.findLast((carrier) => carrier.unit !== undefined)?.unit,
  }
}

/**
 * Per-message credit total (dedupe-per-message rule of `messageCredits`), or
 * undefined when no part carries credit metadata.
 */
export function creditsForMessage(parts: ReadonlyArray<CreditPart>): number | undefined {
  return messageCredits(parts)?.credits
}

/**
 * Sum turn totals across a session's ASSISTANT messages — exactly one value
 * per message. The unit is whatever the most recent carrier reported (message
 * order, then part order); the SDK metadata is its only source, never a
 * client-side constant. Empty/credit-free sessions yield `{ total: 0 }`.
 */
export function sumSessionCredits(
  messages: ReadonlyArray<CreditMessage>,
  partsByMessage: (messageID: string) => ReadonlyArray<CreditPart>,
): SessionCredits {
  return messages
    .filter((message) => message.role === "assistant")
    .reduce<SessionCredits>(
      (acc, message) => {
        const hit = messageCredits(partsByMessage(message.id))
        if (!hit) return acc
        return {
          total: acc.total + hit.credits,
          unit: hit.unit ?? acc.unit,
        }
      },
      { total: 0, unit: undefined },
    )
}

// Explicit locale keeps helper output deterministic for unit tests; the
// builtin context box pins "en-US" for its money formatter the same way.
const creditsAmount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

/**
 * Render a credits value with the SDK-reported unit, e.g. `"12.5 credits"`,
 * `"1 credit"`, `"0 credits"`. The unit text comes from `creditsUnit`
 * verbatim (kiro-cli reports the singular "credit") and is naively pluralized
 * unless it already ends in "s". With no unit known yet (no metadata) only
 * the number renders — a unit string is never invented client-side.
 */
export function formatCredits(value: number, unit?: string): string {
  const amount = creditsAmount.format(Number.isFinite(value) ? value : 0)
  if (!unit) return amount
  const label = value === 1 || unit.endsWith("s") ? unit : `${unit}s`
  return `${amount} ${label}`
}
