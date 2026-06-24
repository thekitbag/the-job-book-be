import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { buildFreshQueueSections } from './review-queue.js'
import {
  STRICT_DECIMAL_RE as COST_DECIMAL_RE,
  strictParsePositive,
  formatUnitCostLabel,
  formatLineTotalLabel,
} from '../lib/cost-utils.js'

const MEMORY_TYPE_TO_SECTION: Record<string, string> = {
  ORDERED_MATERIAL: 'ordered_materials',
  USED_MATERIAL: 'used_materials',
  LEFTOVER_MATERIAL: 'leftovers',
  SUPPLIER_DELIVERY_NOTE: 'supplier_delivery_notes',
  CUSTOMER_CHANGE: 'customer_changes',
  WATCH_OUT: 'watch_outs',
}

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

// itemLabel must be non-empty: prefer trimmed materialName, fall back to the
// trimmed memory item summary. Only when both are blank do we use a safe
// generic label rather than emitting an empty string.
function resolveItemLabel(materialName: string | null, summary: string): string {
  const trimmedName = materialName?.trim()
  if (trimmedName) return trimmedName
  const trimmedSummary = summary?.trim()
  if (trimmedSummary) return trimmedSummary
  return 'Bought item'
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

function buildOrderedMaterialsCostSummary(
  items: Array<{
    id: string
    materialName: string | null
    quantity: string | null
    unit: string | null
    summary: string
    costAmount: string | null
    costCurrency: string | null
    totalCostAmount: string | null
    unresolvedFlags: string[]
  }>,
): OrderedMaterialsCostSummary {
  type Item = (typeof items)[number]

  const gbpItems: IncludedItem[] = []
  const excludedRows: ExcludedSpendRow[] = []

  // Classify each trusted bought/ordered item exactly once: it either contributes
  // an included GBP line total, or it gets an excluded row with a reason.
  const excludeRow = (m: Item, reason: SpendExclusionReason) => {
    excludedRows.push({
      memoryItemId: m.id,
      itemLabel: resolveItemLabel(m.materialName, m.summary),
      materialName: m.materialName,
      quantity: m.quantity,
      unit: m.unit,
      reason,
    })
  }

  for (const m of items) {
    // no_cost_remembered: both costAmount and totalCostAmount absent, no other
    // cost evidence (unresolved flags count as evidence worth checking).
    if (m.unresolvedFlags.length === 0 && !m.totalCostAmount && !m.costAmount) {
      excludeRow(m, 'no_cost_remembered')
      continue
    }
    // Everything else excluded is cost_worth_checking: unresolved flags, an
    // ambiguous basis (costAmount without a safe total), or missing currency.
    if (m.unresolvedFlags.length > 0 || !m.totalCostAmount || !m.costCurrency) {
      excludeRow(m, 'cost_worth_checking')
      continue
    }
    // Trusted line total present. Only GBP contributes to the pilot aggregate;
    // any other currency is excluded as worth checking.
    if (m.costCurrency !== 'GBP') {
      excludeRow(m, 'cost_worth_checking')
      continue
    }
    gbpItems.push({
      id: m.id,
      materialName: m.materialName,
      quantity: m.quantity,
      unit: m.unit,
      totalCostAmount: m.totalCostAmount,
      costCurrency: m.costCurrency,
    })
  }

  let knownSpendAmount: string | null = null
  let knownSpendLabel: string | null = null

  if (gbpItems.length > 0) {
    const total = gbpItems.reduce((sum, i) => {
      const amt = strictParsePositive(i.totalCostAmount)
      return sum + (amt ?? 0)
    }, 0)
    knownSpendAmount = String(Math.round(total * 100) / 100)
    knownSpendLabel = `£${knownSpendAmount} known spend`
  }

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

const SECTION_CONFIG = [
  { key: 'ordered_materials', label: 'Ordered materials' },
  { key: 'used_materials', label: 'Used materials' },
  { key: 'leftovers', label: 'Leftovers' },
  { key: 'supplier_delivery_notes', label: 'Supplier delivery notes' },
  { key: 'customer_changes', label: 'Customer changes' },
  { key: 'watch_outs', label: 'Watch outs' },
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
    buildFreshQueueSections(jobId, new Date()),
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

  const costSummary = {
    orderedMaterials: buildOrderedMaterialsCostSummary(bySection.get('ordered_materials') ?? []),
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
