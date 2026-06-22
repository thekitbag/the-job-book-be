// Only strings that are purely numeric — no units, approximations, or partial text.
export const STRICT_DECIMAL_RE = /^\d+(\.\d+)?$/

export function strictParsePositive(s: string | null | undefined): number | null {
  if (!s || !STRICT_DECIMAL_RE.test(s)) return null
  const n = parseFloat(s)
  return n > 0 ? n : null
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

// Pure derivation: qty × unitCost when qualifier is 'each' and both are strict positives.
// Does not consult any existing totalCostAmount — caller decides whether to use the result.
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
