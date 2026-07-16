// Only strings that are purely numeric — no units, approximations, or partial text.
export const STRICT_DECIMAL_RE = /^\d+(\.\d+)?$/

export function strictParsePositive(s: string | null | undefined): number | null {
  if (!s || !STRICT_DECIMAL_RE.test(s)) return null
  const n = parseFloat(s)
  return n > 0 ? n : null
}

// A non-empty display label for a bought/ordered item: prefer trimmed materialName,
// fall back to the trimmed memory item summary, and only use a safe generic label
// when both are blank. Shared by the known-spend and budget summaries.
export function resolveSpendItemLabel(
  materialName: string | null | undefined,
  summary: string | null | undefined,
): string {
  const trimmedName = materialName?.trim()
  if (trimmedName) return trimmedName
  const trimmedSummary = summary?.trim()
  if (trimmedSummary) return trimmedSummary
  return 'Bought item'
}

// Returns "£5 each" / "EUR 5 each" — only when qualifier is 'each' and currency is present.
export function formatUnitCostLabel(
  costAmount: string | null | undefined,
  costCurrency: string | null | undefined,
  costQualifier: string | null | undefined,
): string | null {
  if (!costAmount || costQualifier !== 'each' || !costCurrency) return null
  const symbol = costCurrency === 'GBP' ? '£' : `${costCurrency} `
  return `${symbol}${costAmount} each`
}

// Returns "£600 total" / "EUR 600 total" — only when currency is present.
export function formatLineTotalLabel(
  totalCostAmount: string | null | undefined,
  costCurrency: string | null | undefined,
): string | null {
  if (!totalCostAmount || !costCurrency) return null
  const symbol = costCurrency === 'GBP' ? '£' : `${costCurrency} `
  return `${symbol}${totalCostAmount} total`
}

// Returns "£80 refund" — only when a refund amount and currency are present.
// Refund is money back on returned materials, kept separate from spend labels.
export function formatRefundLabel(
  refundAmount: string | null | undefined,
  refundCurrency: string | null | undefined,
): string | null {
  if (!refundAmount || !refundCurrency) return null
  const symbol = refundCurrency === 'GBP' ? '£' : `${refundCurrency} `
  return `${symbol}${refundAmount} refund`
}

// Pure arithmetic: qty × unitCost when qualifier is 'each' and both are strict
// positives. Basis-only (no unit/currency); used for conflict detection where the
// question is purely whether an explicit total disagrees with quantity × unit cost.
export function deriveSafeLineTotal(
  quantity: string | null | undefined,
  costAmount: string | null | undefined,
  costQualifier: string | null | undefined,
): string | null {
  if (costQualifier !== 'each') return null
  const qty = strictParsePositive(quantity)
  const cost = strictParsePositive(costAmount)
  if (qty === null || cost === null) return null
  return String(Math.round(qty * cost * 100) / 100)
}

// Authoritative rule for a *stored* material line total. Derives qty × unit cost
// only when the whole basis is unambiguous: qualifier 'each', a strict-positive
// quantity, a present unit, a strict-positive unit cost, and a currency. This is
// the single derivation used by every write path so stored totals stay consistent
// (`5 sheets at £20 each` → `100`; `5 at £20 each` with no unit/currency → null).
export function deriveSafeMaterialTotal(
  quantity: string | null | undefined,
  unit: string | null | undefined,
  costAmount: string | null | undefined,
  costCurrency: string | null | undefined,
  costQualifier: string | null | undefined,
): string | null {
  if (costQualifier !== 'each') return null
  if (!unit || unit.trim() === '') return null
  if (!costCurrency || costCurrency.trim() === '') return null
  return deriveSafeLineTotal(quantity, costAmount, costQualifier)
}

// Pure derivation: labourHours × hourlyRate when qualifier is 'per_hour' and both
// are strict positives. Mirrors deriveSafeLineTotal for labour money.
export function deriveSafeLabourTotal(
  labourHours: string | null | undefined,
  costAmount: string | null | undefined,
  costQualifier: string | null | undefined,
): string | null {
  if (costQualifier !== 'per_hour') return null
  const hours = strictParsePositive(labourHours)
  const rate = strictParsePositive(costAmount)
  if (hours === null || rate === null) return null
  return String(Math.round(hours * rate * 100) / 100)
}

// True when a stored totalCostAmount conflicts with the derivable amount.
// Returns false whenever derivation is impossible (non-'each' qualifier, non-numeric fields, missing total).
export function hasCostConflict(
  quantity: string | null | undefined,
  costAmount: string | null | undefined,
  costQualifier: string | null | undefined,
  totalCostAmount: string | null | undefined,
): boolean {
  if (!totalCostAmount) return false
  const derived = deriveSafeLineTotal(quantity, costAmount, costQualifier)
  if (derived === null) return false
  const total = strictParsePositive(totalCostAmount)
  if (total === null) return false
  return Math.abs(parseFloat(derived) - total) > 0.001
}
