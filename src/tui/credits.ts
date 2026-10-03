// pure credit helpers (no opentui/solid imports, so they test under plain Node).
// The host stores metadata[providerMetadataKey] key-unwrapped, so credits live at part.state.credits /
// part.state.creditsUnit on text and reasoning content parts — never nested under a provider key.
// dedupe: count once per message; text and reasoning parts carry the same turn total (dual emission), so last-carrier-wins and parts are never summed.

/** Any part-like object. `object` (not `{ state?: unknown }`) so state-less content-part variants stay assignable. */
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
   * True once any assistant message carried kiro credits. Lets the view pick credits over the
   * "$X spent" fallback, since a 0-credit kiro turn is indistinguishable from no metadata by
   * `total` alone.
   */
  present: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Validate key-unwrapped credit state (`{ credits, creditsUnit }`); only finite numeric credits count,
 * and only non-empty string units. Shared by durable part reads and the transient text-ended store so
 * both paths accept exactly the same shapes.
 */
export function readCreditState(state: unknown): PartCredits | undefined {
  if (!isRecord(state)) return undefined
  if (typeof state.credits !== "number" || !Number.isFinite(state.credits)) return undefined
  return {
    credits: state.credits,
    unit: typeof state.creditsUnit === "string" && state.creditsUnit.length > 0 ? state.creditsUnit : undefined,
  }
}

/** Only text and reasoning content parts carry kiro metadata. */
function carrierState(part: CreditPart): unknown {
  if (!isRecord(part)) return undefined
  if (part.type !== "text" && part.type !== "reasoning") return undefined
  return part.state
}

/** Read key-unwrapped `state.credits`/`state.creditsUnit` from a text or reasoning content part. */
export function readPartCredits(part: CreditPart): PartCredits | undefined {
  return readCreditState(carrierState(part))
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

/**
 * Fold one assistant message's credits into the session rollup: credits add to the total and the
 * unit follows the most recent carrier. Messages without credits leave the rollup untouched.
 */
export function addMessageCredits(acc: SessionCredits, hit: PartCredits | undefined): SessionCredits {
  if (!hit) return acc
  return {
    total: acc.total + hit.credits,
    unit: hit.unit ?? acc.unit,
    present: true,
  }
}

/**
 * Sum per-message totals across a session's assistant messages (one value each); unit from the most
 * recent carrier.
 */
export function sumSessionCredits(
  messages: ReadonlyArray<CreditMessage>,
  partsByMessage: (messageID: string) => ReadonlyArray<CreditPart>,
): SessionCredits {
  return messages
    .filter((message) => message.role === "assistant")
    .reduce<SessionCredits>(
      (acc, message) => addMessageCredits(acc, messageCredits(partsByMessage(message.id))),
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

/**
 * Single-line text for the footer chip: the formatted total. Empty when the session carries no kiro
 * credits, so the chip collapses.
 */
export function creditsChipText(credits: SessionCredits): string {
  if (!credits.present) return ""
  return formatCredits(credits.total, credits.unit)
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
