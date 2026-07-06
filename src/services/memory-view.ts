import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { deriveFreshQueueSections } from './review-queue.js'
import {
  STRICT_DECIMAL_RE as COST_DECIMAL_RE,
  strictParsePositive,
  formatUnitCostLabel,
  formatLineTotalLabel,
} from '../lib/cost-utils.js'
import { classifySpend, sumKnownSpend } from '../lib/spend-classification.js'
import type { SpendClassifiable } from '../lib/spend-classification.js'
import { MEMORY_TYPES } from '../lib/memory-types.js'

// Trusted-memory sections come from the shared registry; UNCLEAR is excluded
// because it is never a trusted memory type and has no memory-view section.
const MEMORY_TYPE_TO_SECTION: Record<string, string> = Object.fromEntries(
  MEMORY_TYPES.filter((t) => t.storedType !== 'UNCLEAR').map((t) => [t.storedType, t.sectionKey]),
)

// Build a display cost label from stored cost fields (GBP only for now; ISO code fallback)
function formatCostLabel(
  costAmount: string | null,
  costCurrency: string | null,
  costQualifier: string | null,
): string | null {
  if (!costAmount) return null
  const symbol = costCurrency === 'GBP' ? '£' : (costCurrency ? `${costCurrency} ` : '')
  const qualifier = costQualifier === 'each' ? ' each'
    : costQualifier === 'approx' ? ' (approx)' : ''
  return `${symbol}${costAmount}${qualifier}`
}

function formatTotalCostLabel(totalCostAmount: string | null, costCurrency: string | null): string | null {
  if (!totalCostAmount) return null
  const symbol = costCurrency === 'GBP' ? '£' : (costCurrency ? `${costCurrency} ` : '')
  return `${symbol}${totalCostAmount} total`
}

// Summary sections cover only the three scan-relevant types for bought/used/leftovers.
const SUMMARY_SECTION_KEYS = ['ordered_materials', 'used_materials', 'leftovers'] as const
const SUMMARY_SECTION_LABELS: Record<string, string> = {
  ordered_materials: 'Bought / ordered',
  used_materials: 'Used',
  leftovers: 'Leftovers',
}

interface SummaryRow {
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  costLabel: string | null
  totalCostLabel: string | null
  uncertaintyFlags: string[]
  memoryItemIds: string[]
}

const SUMMARY_STRICT_DECIMAL_RE = /^\d+(\.\d+)?$/

// Groups rows with the same materialName + unit. Merges quantities when all
// rows in the group have strict numeric quantities and no uncertainty flags.
// Incompatible or uncertain rows are kept as separate entries.
function consolidateSummaryRows(rows: SummaryRow[]): SummaryRow[] {
  const groups = new Map<string, SummaryRow[]>()
  for (const row of rows) {
    const key = `${row.materialName ?? ''}::${row.unit ?? ''}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const result: SummaryRow[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }
    const allNumeric = group.every(
      (r) => r.quantity != null && SUMMARY_STRICT_DECIMAL_RE.test(r.quantity),
    )
    const noUncertainty = group.every((r) => r.uncertaintyFlags.length === 0)
    if (allNumeric && noUncertainty && group[0].materialName !== null && group[0].unit !== null) {
      const sumQty = group.reduce((acc, r) => acc + parseFloat(r.quantity!), 0)
      const commonSupplier =
        group.every((r) => r.supplierName === group[0].supplierName)
          ? group[0].supplierName
          : null
      result.push({
        materialName: group[0].materialName,
        quantity: String(Math.round(sumQty * 1000) / 1000),
        unit: group[0].unit,
        supplierName: commonSupplier,
        costLabel: null,
        totalCostLabel: null,
        uncertaintyFlags: [],
        memoryItemIds: group.flatMap((r) => r.memoryItemIds),
      })
    } else {
      result.push(...group)
    }
  }
  return result
}

// ── Cost summary ─────────────────────────────────────────────────────────────

interface CostRow {
  key: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  lineTotalAmount: string
  lineTotalCurrency: string
  lineTotalLabel: string
  memoryItemIds: string[]
}

type SpendExclusionReason = 'no_cost_remembered' | 'cost_worth_checking'

interface ExcludedSpendRow {
  memoryItemId: string
  itemLabel: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  reason: SpendExclusionReason
}

interface OrderedMaterialsCostSummary {
  knownSpendAmount: string | null
  knownSpendCurrency: string | null
  knownSpendLabel: string | null
  includedMemoryItemIds: string[]
  missingCostCount: number
  uncertainCostCount: number
  excludedMemoryItemIds: string[]
  rows: CostRow[]
  excludedRows: ExcludedSpendRow[]
}

type IncludedItem = {
  id: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  totalCostAmount: string
  costCurrency: string
}

function buildCostRows(items: IncludedItem[]): CostRow[] {
  const groups = new Map<string, IncludedItem[]>()

  for (const item of items) {
    if (!item.unit || !item.materialName) {
      groups.set(`id:${item.id}`, [item])
    } else {
      const key = `${item.materialName.toLowerCase()}|${item.unit.toLowerCase()}`
      const group = groups.get(key)
      if (group) group.push(item)
      else groups.set(key, [item])
    }
  }

  const rows: CostRow[] = []

  for (const [groupKey, group] of groups) {
    const first = group[0]
    if (group.length === 1) {
      const key = first.materialName && first.unit
        ? `${first.materialName.toLowerCase()}|${first.unit.toLowerCase()}`
        : `id:${first.id}`
      rows.push({
        key,
        materialName: first.materialName,
        quantity: first.quantity,
        unit: first.unit,
        lineTotalAmount: first.totalCostAmount,
        lineTotalCurrency: first.costCurrency,
        lineTotalLabel: formatLineTotalLabel(first.totalCostAmount, first.costCurrency) ?? `${first.totalCostAmount} total`,
        memoryItemIds: [first.id],
      })
    } else {
      const allNumericQty = group.every(
        (i) => i.quantity != null && COST_DECIMAL_RE.test(i.quantity),
      )
      const allNumericTotal = group.every((i) => COST_DECIMAL_RE.test(i.totalCostAmount))

      if (allNumericQty && allNumericTotal) {
        const sumQty = group.reduce((s, i) => s + parseFloat(i.quantity!), 0)
        const sumAmt = group.reduce((s, i) => s + parseFloat(i.totalCostAmount), 0)
        const roundedQty = String(Math.round(sumQty * 1000) / 1000)
        const roundedAmt = String(Math.round(sumAmt * 100) / 100)
        rows.push({
          key: groupKey,
          materialName: first.materialName,
          quantity: roundedQty,
          unit: first.unit,
          lineTotalAmount: roundedAmt,
          lineTotalCurrency: first.costCurrency,
          lineTotalLabel: formatLineTotalLabel(roundedAmt, first.costCurrency) ?? `${roundedAmt} total`,
          memoryItemIds: group.map((i) => i.id),
        })
      } else {
        for (const item of group) {
          rows.push({
            key: `id:${item.id}`,
            materialName: item.materialName,
            quantity: item.quantity,
            unit: item.unit,
            lineTotalAmount: item.totalCostAmount,
            lineTotalCurrency: item.costCurrency,
            lineTotalLabel: formatLineTotalLabel(item.totalCostAmount, item.costCurrency) ?? `${item.totalCostAmount} total`,
            memoryItemIds: [item.id],
          })
        }
      }
    }
  }
  return rows
}

function buildOrderedMaterialsCostSummary(items: SpendClassifiable[]): OrderedMaterialsCostSummary {
  const gbpItems: IncludedItem[] = []
  const excludedRows: ExcludedSpendRow[] = []

  // The include/exclude decision and reason come from the shared classifier
  // (lib/spend-classification.ts) — the same rules budget-summary uses.
  for (const m of items) {
    const classified = classifySpend(m)
    if (classified.kind === 'non_spend') continue
    if (classified.kind === 'excluded') {
      const r = classified.row
      excludedRows.push({
        memoryItemId: r.memoryItemId,
        itemLabel: r.itemLabel,
        materialName: r.materialName,
        quantity: r.quantity,
        unit: r.unit,
        reason: r.reason as SpendExclusionReason,
      })
      continue
    }
    gbpItems.push({
      id: classified.row.memoryItemId,
      materialName: classified.row.materialName,
      quantity: classified.row.quantity,
      unit: classified.row.unit,
      totalCostAmount: classified.row.lineTotalAmount,
      costCurrency: classified.row.lineTotalCurrency,
    })
  }

  const knownSpendAmount = gbpItems.length > 0 ? sumKnownSpend(gbpItems.map((i) => i.totalCostAmount)) : null
  const knownSpendLabel = knownSpendAmount !== null ? `£${knownSpendAmount} known spend` : null

  // Legacy ID arrays and counts are derived from the classified rows, not a
  // separate branch, so the two views can never disagree.
  return {
    knownSpendAmount,
    knownSpendCurrency: gbpItems.length > 0 ? 'GBP' : null,
    knownSpendLabel,
    includedMemoryItemIds: gbpItems.map((i) => i.id),
    missingCostCount: excludedRows.filter((r) => r.reason === 'no_cost_remembered').length,
    uncertainCostCount: excludedRows.filter((r) => r.reason === 'cost_worth_checking').length,
    excludedMemoryItemIds: excludedRows.map((r) => r.memoryItemId),
    rows: buildCostRows(gbpItems),
    excludedRows,
  }
}

// ── Labour cost summary ───────────────────────────────────────────────────────

type LabourExclusionReason = 'no_rate_or_cost' | 'cost_worth_checking'

// Classify each LABOUR memory item through the shared classifier: a safe GBP
// monetary total contributes to known cost; hours-only labour is remembered but
// excluded as `no_rate_or_cost`; anything else excluded with cost left to check.
function buildLabourCostSummary(items: SpendClassifiable[]) {
  const included: Array<{
    memoryItemId: string
    itemLabel: string
    labourHours: string | null
    labourPerson: string | null
    labourTask: string | null
    lineTotalAmount: string
    lineTotalCurrency: string
    lineTotalLabel: string
  }> = []
  const excludedRows: Array<{
    memoryItemId: string
    itemLabel: string
    labourHours: string | null
    labourPerson: string | null
    labourTask: string | null
    reason: LabourExclusionReason
  }> = []

  for (const m of items) {
    const classified = classifySpend(m)
    if (classified.kind === 'non_spend') continue
    if (classified.kind === 'excluded') {
      const r = classified.row
      excludedRows.push({
        memoryItemId: r.memoryItemId,
        itemLabel: r.itemLabel,
        labourHours: r.labourHours,
        labourPerson: r.labourPerson,
        labourTask: r.labourTask,
        reason: r.reason as LabourExclusionReason,
      })
      continue
    }
    const r = classified.row
    included.push({
      memoryItemId: r.memoryItemId,
      itemLabel: r.itemLabel,
      labourHours: r.labourHours,
      labourPerson: r.labourPerson,
      labourTask: r.labourTask,
      lineTotalAmount: r.lineTotalAmount,
      lineTotalCurrency: r.lineTotalCurrency,
      lineTotalLabel: r.lineTotalLabel,
    })
  }

  const knownSpendAmount = included.length > 0 ? sumKnownSpend(included.map((i) => i.lineTotalAmount)) : null
  const knownSpendLabel = knownSpendAmount !== null ? `£${knownSpendAmount} known spend` : null

  return {
    knownSpendAmount,
    knownSpendCurrency: included.length > 0 ? 'GBP' : null,
    knownSpendLabel,
    includedMemoryItemIds: included.map((i) => i.memoryItemId),
    excludedRows,
    rows: included,
  }
}

// Combine ordered-material and labour known cost into a single job-level total.
// Equals budget-summary.totals.knownSpendAmount for the same GBP state.
function buildTotalKnownCost(
  ordered: { knownSpendAmount: string | null; includedMemoryItemIds: string[] },
  labour: { knownSpendAmount: string | null; includedMemoryItemIds: string[] },
) {
  const includedMemoryItemIds = [...ordered.includedMemoryItemIds, ...labour.includedMemoryItemIds]
  if (ordered.knownSpendAmount === null && labour.knownSpendAmount === null) {
    return { knownSpendAmount: null, knownSpendCurrency: null, knownSpendLabel: null, includedMemoryItemIds }
  }
  const total =
    (strictParsePositive(ordered.knownSpendAmount) ?? 0) +
    (strictParsePositive(labour.knownSpendAmount) ?? 0)
  const knownSpendAmount = String(Math.round(total * 100) / 100)
  return {
    knownSpendAmount,
    knownSpendCurrency: 'GBP',
    knownSpendLabel: `£${knownSpendAmount} known cost`,
    includedMemoryItemIds,
  }
}

const SECTION_CONFIG = [
  { key: 'ordered_materials', label: 'Ordered materials' },
  { key: 'used_materials', label: 'Used materials' },
  { key: 'leftovers', label: 'Leftovers' },
  { key: 'supplier_delivery_notes', label: 'Supplier delivery notes' },
  { key: 'customer_changes', label: 'Customer changes' },
  { key: 'watch_outs', label: 'Watch outs' },
  { key: 'labour', label: 'Labour' },
  { key: 'general_notes', label: 'Notes' },
] as const

export async function getMemoryView(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      ownerUserId: true,
      title: true,
      jobType: true,
      status: true,
      roughLocationOrLabel: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const [memoryItems, { sections: queueSections }] = await Promise.all([
    prisma.memoryItem.findMany({
      where: { jobId },
      include: {
        sourceFact: {
          include: {
            sourceNote: { select: { id: true, capturedAt: true } },
            transcript: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    deriveFreshQueueSections(jobId, new Date()),
  ])

  // Group memory items by section key derived from memoryType
  const bySection = new Map<string, typeof memoryItems>(SECTION_CONFIG.map((s) => [s.key, []]))
  for (const item of memoryItems) {
    const key = MEMORY_TYPE_TO_SECTION[item.memoryType as string]
    bySection.get(key)?.push(item)
  }

  const sections = SECTION_CONFIG.map(({ key, label }) => ({
    key,
    label,
    items: (bySection.get(key) ?? []).map((m) => {
      const fact = m.sourceFact ?? null
      return {
        id: m.id,
        memoryType: (m.memoryType as string).toLowerCase(),
        summary: m.summary,
        materialName: m.materialName,
        quantity: m.quantity,
        unit: m.unit,
        supplierName: m.supplierName,
        deliveryTiming: m.deliveryTiming,
        locationOrUse: m.locationOrUse,
        costAmount: m.costAmount,
        costCurrency: m.costCurrency,
        costQualifier: m.costQualifier,
        totalCostAmount: m.totalCostAmount,
        labourHours: m.labourHours,
        labourPerson: m.labourPerson,
        labourTask: m.labourTask,
        happenedAt: m.happenedAt,
        isManual: m.isManual,
        budgetCategoryId: m.budgetCategoryId,
        unitCostLabel: formatUnitCostLabel(m.costAmount, m.costCurrency, m.costQualifier),
        lineTotalLabel: formatLineTotalLabel(m.totalCostAmount, m.costCurrency),
        uncertaintyFlags: m.unresolvedFlags,
        sourceUncertaintyFlags: fact?.uncertaintyFlags ?? [],
        sourceCandidateFactId: m.sourceCandidateFactId,
        reviewDecisionId: m.reviewDecisionId,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        source: fact
          ? {
              candidateFactId: fact.id,
              noteId: fact.sourceNoteId,
              transcriptId: fact.sourceTranscriptId,
              capturedAt: fact.sourceNote.capturedAt,
              transcriptText: fact.transcript?.text ?? null,
            }
          : null,
      }
    }),
  }))

  // stillToCheck: current draft queue items from the fresh generation
  const stillToCheckItems = queueSections.flatMap((section) =>
    section.items.map((item) => ({
      id: item.id,
      sectionKey: section.key,
      summary: item.summary,
      kind: item.kind,
      timeLabel: item.timeLabel,
    }))
  )

  // summarySections: consolidated scan view for bought/used/leftovers
  const summarySections = SUMMARY_SECTION_KEYS.map((key) => {
    const rawRows: SummaryRow[] = (bySection.get(key) ?? []).map((m) => ({
      materialName: m.materialName,
      quantity: m.quantity,
      unit: m.unit,
      supplierName: m.supplierName,
      costLabel: formatCostLabel(m.costAmount, m.costCurrency, m.costQualifier),
      totalCostLabel: formatTotalCostLabel(m.totalCostAmount, m.costCurrency),
      uncertaintyFlags: m.unresolvedFlags,
      memoryItemIds: [m.id],
    }))
    return { key, label: SUMMARY_SECTION_LABELS[key], items: consolidateSummaryRows(rawRows) }
  })

  const orderedMaterials = buildOrderedMaterialsCostSummary(bySection.get('ordered_materials') ?? [])
  const labour = buildLabourCostSummary(bySection.get('labour') ?? [])
  const costSummary = {
    orderedMaterials,
    labour,
    totalKnownCost: buildTotalKnownCost(orderedMaterials, labour),
  }

  return {
    job: {
      id: job.id,
      title: job.title,
      jobType: job.jobType,
      status: job.status.toLowerCase(),
      roughLocationOrLabel: job.roughLocationOrLabel,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    generatedAt: new Date().toISOString(),
    sections,
    summarySections,
    costSummary,
    stillToCheck: {
      count: stillToCheckItems.length,
      items: stillToCheckItems,
    },
  }
}
