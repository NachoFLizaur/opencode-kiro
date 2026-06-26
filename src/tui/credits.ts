// pure credit helpers (no opentui/solid imports, so they test under plain Node).
// credits come from part.metadata?.kiro ({ credits, creditsUnit }), not providerMetadata.
// dedupe: count once per message; text and reasoning parts carry the same turn total (dual emission), so last-carrier-wins and parts are never summed.

/** Any part-like object. `object` (not `{ metadata?: unknown }`) so metadata-less SDK Part variants stay assignable. */
export type CreditPart = object

/** Minimal message shape; SDK `Message` is assignable. */
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
  /**
   * True once any assistant message carried kiro credit metadata. Lets the view pick credits over the
   * "$X spent" fallback, since a 0-credit kiro turn is indistinguishable from no metadata by `total` alone.
   */
  present: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Read `{ kiro: { credits, creditsUnit } }` from a part; only finite numeric credits count. */
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

/** One message's credits, deduped by the last-carrier-wins rule (parts never summed); unit from the most recent carrier. */
export function messageCredits(parts: ReadonlyArray<CreditPart>): PartCredits | undefined {
  const carriers = parts.map(readPartCredits).filter((value): value is PartCredits => value !== undefined)
  const last = carriers.at(-1)
  if (!last) return undefined
  return {
    credits: last.credits,
    unit: last.unit ?? carriers.findLast((carrier) => carrier.unit !== undefined)?.unit,
  }
}

/** Per-message credit total, or undefined when no part carries credits. */
export function creditsForMessage(parts: ReadonlyArray<CreditPart>): number | undefined {
  return messageCredits(parts)?.credits
}

/** Sum per-message totals across a session's assistant messages (one value each); unit from the most recent carrier. */
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
          present: true,
        }
      },
      { total: 0, unit: undefined, present: false },
    )
}

// Explicit locale keeps output deterministic for tests.
const creditsAmount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

/** Render credits with the unit, e.g. "12.5 credits", "1 credit". Unit is naively pluralized unless it ends in "s"; with no unit, only the number renders. */
export function formatCredits(value: number, unit?: string): string {
  const amount = creditsAmount.format(Number.isFinite(value) ? value : 0)
  if (!unit) return amount
  const label = value === 1 || unit.endsWith("s") ? unit : `${unit}s`
  return `${amount} ${label}`
}

// mirrors the builtin sidebar's USD formatter (context.tsx). co-located out of the view so cost lines stay pure and Solid-free for tests.
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/**
 * Muted cost lines as an array (one per rendered row). Three states:
 *   - both (credits present + non-zero cost): ["$X.XX spent", "N credits"]
 *   - credits only (cost 0): ["N credits"]
 *   - dollars only (no credits): ["$X.XX spent"] (also ["$0.00 spent"] when empty)
 * Keys off `credits.present` and `cost > 0`, never `credits.total` alone (a 0-credit kiro turn is present).
 */
export function spendLines(input: { cost: number; credits: SessionCredits }): string[] {
  const { cost, credits } = input
  const dollars = money.format(Number.isFinite(cost) ? cost : 0)
  if (credits.present && cost > 0) {
    return [`${dollars} spent`, formatCredits(credits.total, credits.unit)]
  }
  if (credits.present) {
    return [formatCredits(credits.total, credits.unit)]
  }
  return [`${dollars} spent`]
}
