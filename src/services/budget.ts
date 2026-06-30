import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import {
  STRICT_DECIMAL_RE,
  strictParsePositive,
  formatLineTotalLabel,
  resolveSpendItemLabel,
} from '../lib/cost-utils.js'

// ── Ownership ─────────────────────────────────────────────────────────────────

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
}

// ── Amount helpers (GBP pilot) ────────────────────────────────────────────────

// Parse a non-negative decimal string (allows 0, unlike strictParsePositive).
function parseAmount(s: string | null | undefined): number | null {
  if (!s || !STRICT_DECIMAL_RE.test(s)) return null
  return parseFloat(s)
}

const round2 = (n: number) => Math.round(n * 100) / 100
const gbp = (amount: string) => `£${amount}`

// ── Category shape ────────────────────────────────────────────────────────────

interface CategoryRow {
  id: string
  jobId: string
  name: string
  budgetAmount: string | null
  budgetCurrency: string | null
  sortOrder: number
  isArchived: boolean
  createdAt: Date
  updatedAt: Date
}

function normalizeCategory(c: CategoryRow) {
  return {
    id: c.id,
    jobId: c.jobId,
    name: c.name,
    budgetAmount: c.budgetAmount,
    budgetCurrency: c.budgetCurrency,
    sortOrder: c.sortOrder,
    isArchived: c.isArchived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

// ── Category CRUD ─────────────────────────────────────────────────────────────

export async function listBudgetCategories(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const categories = await prisma.jobBudgetCategory.findMany({
    where: { jobId, isArchived: false },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return categories.map(normalizeCategory)
}

export interface CreateBudgetCategoryInput {
  name: string
  budgetAmount?: string | null
  budgetCurrency?: string | null
  sortOrder?: number
}

export async function createBudgetCategory(
  jobId: string,
  userId: string,
  input: CreateBudgetCategoryInput,
) {
  await verifyJobOwnership(jobId, userId)

  const name = input.name.trim()
  const hasBudget = input.budgetAmount != null
  const created = await prisma.jobBudgetCategory.create({
    data: {
      jobId,
      name,
      budgetAmount: hasBudget ? input.budgetAmount : null,
      // Budget currency is GBP whenever an amount is present in this pilot slice.
      budgetCurrency: hasBudget ? (input.budgetCurrency ?? 'GBP') : null,
      sortOrder: input.sortOrder ?? 0,
    },
  })
  return normalizeCategory(created)
}

export interface PatchBudgetCategoryInput {
  name?: string
  budgetAmount?: string | null
  budgetCurrency?: string | null
  sortOrder?: number
  isArchived?: boolean
}

export async function patchBudgetCategory(
  jobId: string,
  categoryId: string,
  userId: string,
  patch: PatchBudgetCategoryInput,
) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.jobBudgetCategory.findFirst({ where: { id: categoryId, jobId } })
  if (!existing) throw { code: ErrorCode.BUDGET_CATEGORY_NOT_FOUND, message: 'Budget category not found' }

  // undefined means "field not in the patch"; null is an explicit clear.
  const data: Record<string, unknown> = {}
  if (patch.name != null) data.name = patch.name.trim()
  if (patch.sortOrder != null) data.sortOrder = patch.sortOrder
  if (patch.isArchived != null) data.isArchived = patch.isArchived

  // budgetAmount and budgetCurrency move together so currency stays consistent.
  if (patch.budgetAmount !== undefined) {
    if (patch.budgetAmount === null) {
      data.budgetAmount = null
      data.budgetCurrency = null
    } else {
      data.budgetAmount = patch.budgetAmount
      data.budgetCurrency = patch.budgetCurrency ?? existing.budgetCurrency ?? 'GBP'
    }
  } else if (patch.budgetCurrency != null) {
    data.budgetCurrency = patch.budgetCurrency
  }

  const archiving = patch.isArchived === true

  const updated = await prisma.$transaction(async (tx) => {
    const cat = await tx.jobBudgetCategory.update({ where: { id: categoryId }, data })
    // Archiving moves any assigned spend back to Uncategorised so no memory item
    // points at a category hidden from the UI.
    if (archiving) {
      await tx.memoryItem.updateMany({
        where: { jobId, budgetCategoryId: categoryId },
        data: { budgetCategoryId: null },
      })
    }
    return cat
  })

  return normalizeCategory(updated)
}

// ── Budget summary ────────────────────────────────────────────────────────────

interface SpendItem {
  id: string
  memoryType: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  costCurrency: string | null
  totalCostAmount: string | null
  unresolvedFlags: string[]
  budgetCategoryId: string | null
}

// A memory item counts toward budget known spend only when it is a trusted
// ORDERED_MATERIAL with a safe GBP line total and no unresolved flags. This is
// the same inclusion rule memory-view uses for job-level Known spend, so the two
// summaries always agree (see the spend-summary invariant in the budget spec).
function isSafeGbpOrderedSpend(item: SpendItem): boolean {
  return (
    item.memoryType === 'ORDERED_MATERIAL' &&
    item.unresolvedFlags.length === 0 &&
    item.costCurrency === 'GBP' &&
    !!item.totalCostAmount
  )
}

function toSpendRow(item: SpendItem) {
  const total = item.totalCostAmount as string
  const currency = item.costCurrency as string
  return {
    memoryItemId: item.id,
    itemLabel: resolveSpendItemLabel(item.materialName, item.summary),
    materialName: item.materialName,
    quantity: item.quantity,
    unit: item.unit,
    lineTotalAmount: total,
    lineTotalCurrency: currency,
    lineTotalLabel: formatLineTotalLabel(total, currency) ?? `${gbp(total)} total`,
  }
}

type SpendRow = ReturnType<typeof toSpendRow>

function sumRows(rows: SpendRow[]): number {
  return rows.reduce((acc, r) => acc + (strictParsePositive(r.lineTotalAmount) ?? 0), 0)
}

function spendBlock(rows: SpendRow[]) {
  if (rows.length === 0) {
    return { knownSpendAmount: null, knownSpendCurrency: null, knownSpendLabel: null }
  }
  const amount = String(round2(sumRows(rows)))
  return {
    knownSpendAmount: amount,
    knownSpendCurrency: 'GBP',
    knownSpendLabel: `${gbp(amount)} known spend`,
  }
}

// Remaining/over-budget for a single budget amount vs a known-spend total.
function budgetMath(budgetAmount: string | null, spend: number) {
  if (budgetAmount == null) {
    return { remainingAmount: null, remainingLabel: null, overBudget: false }
  }
  const budget = parseAmount(budgetAmount) ?? 0
  const remaining = round2(budget - spend)
  const overBudget = spend > budget
  const remainingAmount = String(remaining)
  const remainingLabel = overBudget
    ? `${gbp(String(round2(spend - budget)))} over budget`
    : `${gbp(remainingAmount)} remaining`
  return { remainingAmount, remainingLabel, overBudget }
}

export async function getBudgetSummary(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const [categories, items] = await Promise.all([
    prisma.jobBudgetCategory.findMany({
      where: { jobId, isArchived: false },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.memoryItem.findMany({ where: { jobId, memoryType: 'ORDERED_MATERIAL' } }),
  ])

  const safe = (items as SpendItem[]).filter(isSafeGbpOrderedSpend)

  // Group safe rows by category id (null → uncategorised).
  const rowsByCategory = new Map<string, SpendRow[]>()
  const uncategorizedRows: SpendRow[] = []
  for (const item of safe) {
    const row = toSpendRow(item)
    if (item.budgetCategoryId == null) {
      uncategorizedRows.push(row)
    } else {
      const list = rowsByCategory.get(item.budgetCategoryId)
      if (list) list.push(row)
      else rowsByCategory.set(item.budgetCategoryId, [row])
    }
  }

  const categorySummaries = categories.map((c) => {
    const rows = rowsByCategory.get(c.id) ?? []
    const spend = sumRows(rows)
    const spendInfo = spendBlock(rows)
    const math = budgetMath(c.budgetAmount, spend)
    return {
      category: normalizeCategory(c),
      ...spendInfo,
      budgetAmount: c.budgetAmount,
      budgetCurrency: c.budgetAmount != null ? (c.budgetCurrency ?? 'GBP') : null,
      budgetLabel: c.budgetAmount != null ? `${gbp(c.budgetAmount)} budget` : null,
      remainingAmount: math.remainingAmount,
      remainingLabel: math.remainingLabel,
      overBudget: math.overBudget,
      rows,
    }
  })

  const uncategorized = {
    ...spendBlock(uncategorizedRows),
    rows: uncategorizedRows,
  }

  // Totals: budget sums active category budgets; known spend sums every safe row.
  const totalBudgetNum = categories.reduce((acc, c) => acc + (parseAmount(c.budgetAmount) ?? 0), 0)
  const anyBudget = categories.some((c) => c.budgetAmount != null)
  const totalSpendNum = sumRows([...categorySummaries.flatMap((s) => s.rows), ...uncategorizedRows])
  const anySpend = safe.length > 0

  const totalBudgetAmount = anyBudget ? String(round2(totalBudgetNum)) : null
  const totalSpendAmount = anySpend ? String(round2(totalSpendNum)) : null

  let remainingAmount: string | null = null
  let remainingLabel: string | null = null
  let overBudget = false
  if (anyBudget) {
    const remaining = round2(totalBudgetNum - totalSpendNum)
    overBudget = totalSpendNum > totalBudgetNum
    remainingAmount = String(remaining)
    remainingLabel = overBudget
      ? `${gbp(String(round2(totalSpendNum - totalBudgetNum)))} over budget`
      : `${gbp(remainingAmount)} remaining`
  }

  return {
    jobId,
    generatedAt: new Date().toISOString(),
    categories: categorySummaries,
    uncategorized,
    totals: {
      budgetAmount: totalBudgetAmount,
      budgetCurrency: anyBudget ? 'GBP' : null,
      knownSpendAmount: totalSpendAmount,
      knownSpendCurrency: anySpend ? 'GBP' : null,
      remainingAmount,
      remainingLabel,
      overBudget,
    },
  }
}

// ── Assignment validation (used by memory-item patch) ─────────────────────────

// Verify a category exists in the job and is assignable; throws on failure.
export async function assertAssignableCategory(jobId: string, categoryId: string) {
  const category = await prisma.jobBudgetCategory.findFirst({ where: { id: categoryId, jobId } })
  if (!category) throw { code: ErrorCode.BUDGET_CATEGORY_NOT_FOUND, message: 'Budget category not found' }
  if (category.isArchived) throw { code: ErrorCode.BUDGET_CATEGORY_ARCHIVED, message: 'Cannot assign to an archived category' }
}

// ── Review-time category suggestion (no ownership check; caller verifies) ──────

type NormalizedCategory = ReturnType<typeof normalizeCategory>

export async function getActiveBudgetCategories(jobId: string): Promise<NormalizedCategory[]> {
  const categories = await prisma.jobBudgetCategory.findMany({
    where: { jobId, isArchived: false },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return categories.map(normalizeCategory)
}

export interface BudgetCategorySuggestion {
  budgetCategoryId: string
  categoryName: string
  reason: 'material_name_match' | 'summary_match'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Deterministic, strong-evidence-only suggestion for a bought/ordered proposed
// memory. No fuzzy/substring/supplier/AI matching. A single exact materialName
// match wins; otherwise a single whole-word/phrase match of a category name in
// the summary is used. Anything ambiguous yields no suggestion.
export function suggestBudgetCategory(
  memoryType: string,
  materialName: string | null,
  summary: string | null,
  categories: NormalizedCategory[],
): BudgetCategorySuggestion | null {
  if (memoryType !== 'ordered_material' || categories.length === 0) return null

  const mat = materialName?.trim().toLowerCase()
  const nameMatches = mat ? categories.filter((c) => c.name.trim().toLowerCase() === mat) : []
  if (nameMatches.length === 1) {
    const c = nameMatches[0]
    return { budgetCategoryId: c.id, categoryName: c.name, reason: 'material_name_match' }
  }
  // Two or more exact material-name matches are ambiguous → no suggestion.
  if (nameMatches.length > 1) return null

  const text = summary ?? ''
  const summaryMatches = categories.filter((c) => {
    const name = c.name.trim()
    return name.length > 0 && new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text)
  })
  if (summaryMatches.length === 1) {
    const c = summaryMatches[0]
    return { budgetCategoryId: c.id, categoryName: c.name, reason: 'summary_match' }
  }
  return null
}
