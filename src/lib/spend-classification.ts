// Single source of truth for which memory items count as known spend.
// Both `GET /api/jobs/:jobId/memory-view` (costSummary) and
// `GET /api/jobs/:jobId/budget-summary` classify through here, so their
// inclusion/exclusion decisions cannot drift apart.
//
// Rules (GBP pilot):
//   included    — ORDERED_MATERIAL or LABOUR, no unresolved flags, a stored
//                 totalCostAmount, and costCurrency === 'GBP'
//   excluded    — everything else that is a spend type, with a reason:
//                 · no cost evidence at all → 'no_cost_remembered' (materials)
//                   / 'no_rate_or_cost' (labour)
//                 · unresolved flags, ambiguous basis (costAmount without a
//                   safe total), missing currency, or non-GBP total
//                   → 'cost_worth_checking'
//   non-spend   — every other memory type never contributes
import { strictParsePositive, formatLineTotalLabel, resolveSpendItemLabel } from './cost-utils.js'

export const SPEND_MEMORY_TYPES = new Set(['ORDERED_MATERIAL', 'LABOUR'])

export type SpendExclusionReason = 'no_cost_remembered' | 'no_rate_or_cost' | 'cost_worth_checking'

// The memory-item fields the classifier reads. Matches the Prisma MemoryItem row.
export interface SpendClassifiable {
  id: string
  memoryType: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  labourHours: string | null
  labourPerson: string | null
  labourTask: string | null
  costAmount: string | null
  costCurrency: string | null
  totalCostAmount: string | null
  unresolvedFlags: string[]
  budgetCategoryId?: string | null
}

// Normalized identity/display facts shared by included and excluded rows.
interface SpendItemFacts {
  memoryItemId: string
  memoryType: string
  itemLabel: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  labourHours: string | null
  labourPerson: string | null
  labourTask: string | null
  budgetCategoryId: string | null
}

export interface IncludedSpendRow extends SpendItemFacts {
  lineTotalAmount: string
  lineTotalCurrency: 'GBP'
  lineTotalLabel: string
}

export interface ExcludedSpendRow extends SpendItemFacts {
  reason: SpendExclusionReason
}

export type SpendClassification =
  | { kind: 'included'; row: IncludedSpendRow }
  | { kind: 'excluded'; row: ExcludedSpendRow }
  | { kind: 'non_spend' }

function itemFacts(item: SpendClassifiable): SpendItemFacts {
  return {
    memoryItemId: item.id,
    memoryType: item.memoryType,
    // Prefer materialName for bought items, labourTask for labour, then summary.
    itemLabel: resolveSpendItemLabel(item.materialName ?? item.labourTask, item.summary),
    materialName: item.materialName,
    quantity: item.quantity,
    unit: item.unit,
    labourHours: item.labourHours,
    labourPerson: item.labourPerson,
    labourTask: item.labourTask,
    budgetCategoryId: item.budgetCategoryId ?? null,
  }
}

export function classifySpend(item: SpendClassifiable): SpendClassification {
  if (!SPEND_MEMORY_TYPES.has(item.memoryType)) return { kind: 'non_spend' }

  // No cost evidence at all (unresolved flags count as evidence worth checking).
  if (item.unresolvedFlags.length === 0 && !item.totalCostAmount && !item.costAmount) {
    const reason: SpendExclusionReason =
      item.memoryType === 'LABOUR' ? 'no_rate_or_cost' : 'no_cost_remembered'
    return { kind: 'excluded', row: { ...itemFacts(item), reason } }
  }

  // Unresolved flags, an ambiguous basis (costAmount without a safe stored
  // total), missing currency, or a non-GBP total: excluded, cost worth checking.
  if (
    item.unresolvedFlags.length > 0 ||
    !item.totalCostAmount ||
    !item.costCurrency ||
    item.costCurrency !== 'GBP'
  ) {
    return { kind: 'excluded', row: { ...itemFacts(item), reason: 'cost_worth_checking' } }
  }

  return {
    kind: 'included',
    row: {
      ...itemFacts(item),
      lineTotalAmount: item.totalCostAmount,
      lineTotalCurrency: 'GBP',
      lineTotalLabel: formatLineTotalLabel(item.totalCostAmount, 'GBP') ?? `£${item.totalCostAmount} total`,
    },
  }
}

// Sum of safely-parseable line totals, rounded to pence, as the API's decimal
// string. Returns null for an empty list (no included spend → no total).
export function sumKnownSpend(amounts: Array<string | null | undefined>): string | null {
  if (amounts.length === 0) return null
  const total = amounts.reduce<number>((sum, a) => sum + (strictParsePositive(a) ?? 0), 0)
  return String(Math.round(total * 100) / 100)
}
