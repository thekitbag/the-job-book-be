import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import {
  STRICT_DECIMAL_RE,
  deriveSafeMaterialTotal,
  deriveSafeLabourTotal,
  hasCostConflict,
  formatUnitCostLabel,
  formatLineTotalLabel,
} from '../lib/cost-utils.js'
import { assertAssignableCategory } from './budget.js'

// Memory types for which a budget category is meaningful in this slice.
const CATEGORY_ELIGIBLE_TYPES = new Set(['ORDERED_MATERIAL', 'LABOUR'])

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
}

// Parse an optional ISO date/time string to a Date, rejecting invalid input.
function parseHappenedAt(value: string | null | undefined): Date | null {
  if (value == null || value === '') return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'happenedAt must be a valid ISO date/time' }
  }
  return d
}

export interface MemoryItemPatch {
  memoryType?: string
  summary?: string | null
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  deliveryTiming?: string | null
  locationOrUse?: string | null
  costAmount?: string | null
  costCurrency?: string | null
  costQualifier?: string | null
  totalCostAmount?: string | null
  labourHours?: string | null
  labourPerson?: string | null
  labourTask?: string | null
  happenedAt?: string | null
  uncertaintyResolution?: 'resolved' | 'still_unsure'
  budgetCategoryId?: string | null
}

export async function patchMemoryItem(
  jobId: string,
  memoryItemId: string,
  userId: string,
  patch: MemoryItemPatch,
) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.memoryItem.findFirst({
    where: { id: memoryItemId, jobId },
  })
  if (!existing) throw { code: ErrorCode.MEMORY_ITEM_NOT_FOUND, message: 'Memory item not found' }

  // The final memory type is the patched one (full edit) or the existing one
  // (category-only edit). A category may only live on category-eligible memory.
  const finalMemoryType = patch.memoryType ? patch.memoryType.toUpperCase() : existing.memoryType

  // Category assignment: undefined preserves, null clears, a string must reference
  // a non-archived category in this same job.
  let budgetCategoryId = existing.budgetCategoryId
  if (patch.budgetCategoryId !== undefined) {
    if (patch.budgetCategoryId === null) {
      budgetCategoryId = null
    } else {
      if (!CATEGORY_ELIGIBLE_TYPES.has(finalMemoryType)) {
        throw { code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId is only allowed on ordered_material or labour memory' }
      }
      await assertAssignableCategory(jobId, patch.budgetCategoryId)
      budgetCategoryId = patch.budgetCategoryId
    }
  }

  // If the memory type is (or becomes) category-ineligible, a preserved category
  // is cleared so trusted memory never carries a category on the wrong type.
  if (budgetCategoryId !== null && !CATEGORY_ELIGIBLE_TYPES.has(finalMemoryType)) {
    budgetCategoryId = null
  }

  // Category-only change: no memoryType means update budgetCategoryId alone and
  // leave every existing memory field untouched.
  if (patch.memoryType == null) {
    const updated = await prisma.memoryItem.update({
      where: { id: memoryItemId },
      data: { budgetCategoryId },
      include: {
        sourceFact: {
          include: {
            sourceNote: { select: { id: true, capturedAt: true } },
            transcript: { select: { id: true, text: true } },
          },
        },
      },
    })
    return normalizeMemoryItem(updated, updated.sourceFact ?? null)
  }

  // Effective cost fields after merging patch with existing
  const effQty = 'quantity' in patch ? (patch.quantity ?? null) : existing.quantity
  const effUnit = 'unit' in patch ? (patch.unit ?? null) : existing.unit
  const effCostAmount = 'costAmount' in patch ? (patch.costAmount ?? null) : existing.costAmount
  const effCostCurrency = 'costCurrency' in patch ? (patch.costCurrency ?? null) : existing.costCurrency
  const effCostQualifier = 'costQualifier' in patch ? (patch.costQualifier ?? null) : existing.costQualifier
  const effLabourHours = 'labourHours' in patch ? (patch.labourHours ?? null) : existing.labourHours

  // Re-derive safe line total from effective fields (material each or labour per_hour)
  const derived =
    deriveSafeMaterialTotal(effQty, effUnit, effCostAmount, effCostCurrency, effCostQualifier) ??
    deriveSafeLabourTotal(effLabourHours, effCostAmount, effCostQualifier)

  // Explicit patch value wins; otherwise use derived or preserve existing
  const explicitTotalInPatch = 'totalCostAmount' in patch
  const finalTotalCostAmount = explicitTotalInPatch
    ? (patch.totalCostAmount ?? null)
    : (derived !== null ? derived : existing.totalCostAmount)

  // Recompute cost_uncertain based on final effective data
  const conflict = hasCostConflict(effQty, effCostAmount, effCostQualifier, finalTotalCostAmount)
  let baseFlags = existing.unresolvedFlags
  if (conflict && !baseFlags.includes('cost_uncertain')) {
    baseFlags = [...baseFlags, 'cost_uncertain']
  } else if (!conflict) {
    baseFlags = baseFlags.filter((f) => f !== 'cost_uncertain')
  }
  // 'resolved' may not override a freshly detected arithmetic conflict
  const unresolvedFlags = (!conflict && patch.uncertaintyResolution === 'resolved') ? [] : baseFlags

  const updated = await prisma.memoryItem.update({
    where: { id: memoryItemId },
    data: {
      memoryType: patch.memoryType.toUpperCase() as never,
      budgetCategoryId,
      summary: patch.summary ?? existing.summary,
      materialName: 'materialName' in patch ? patch.materialName ?? null : existing.materialName,
      quantity: 'quantity' in patch ? patch.quantity ?? null : existing.quantity,
      unit: 'unit' in patch ? patch.unit ?? null : existing.unit,
      supplierName: 'supplierName' in patch ? patch.supplierName ?? null : existing.supplierName,
      deliveryTiming: 'deliveryTiming' in patch ? patch.deliveryTiming ?? null : existing.deliveryTiming,
      locationOrUse: 'locationOrUse' in patch ? patch.locationOrUse ?? null : existing.locationOrUse,
      costAmount: 'costAmount' in patch ? patch.costAmount ?? null : existing.costAmount,
      costCurrency: 'costCurrency' in patch ? patch.costCurrency ?? null : existing.costCurrency,
      costQualifier: 'costQualifier' in patch ? patch.costQualifier ?? null : existing.costQualifier,
      totalCostAmount: finalTotalCostAmount,
      labourHours: 'labourHours' in patch ? patch.labourHours ?? null : existing.labourHours,
      labourPerson: 'labourPerson' in patch ? patch.labourPerson ?? null : existing.labourPerson,
      labourTask: 'labourTask' in patch ? patch.labourTask ?? null : existing.labourTask,
      happenedAt: 'happenedAt' in patch ? parseHappenedAt(patch.happenedAt) : existing.happenedAt,
      unresolvedFlags,
    },
    include: {
      sourceFact: {
        include: {
          sourceNote: { select: { id: true, capturedAt: true } },
          transcript: { select: { id: true, text: true } },
        },
      },
    },
  })

  const fact = updated.sourceFact ?? null
  return normalizeMemoryItem(updated, fact)
}

export async function verifyMemoryItem(jobId: string, memoryItemId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.memoryItem.findFirst({ where: { id: memoryItemId, jobId } })
  if (!existing) throw { code: ErrorCode.MEMORY_ITEM_NOT_FOUND, message: 'Memory item not found' }

  const updated = await prisma.memoryItem.update({
    where: { id: memoryItemId },
    data: { unresolvedFlags: [] },
    include: {
      sourceFact: {
        include: {
          sourceNote: { select: { id: true, capturedAt: true } },
          transcript: { select: { id: true, text: true } },
        },
      },
    },
  })

  const fact = updated.sourceFact ?? null
  return normalizeMemoryItem(updated, fact)
}

function normalizeMemoryItem(
  item: {
    id: string
    memoryType: string
    summary: string
    materialName: string | null
    quantity: string | null
    unit: string | null
    supplierName: string | null
    deliveryTiming: string | null
    locationOrUse: string | null
    costAmount: string | null
    costCurrency: string | null
    costQualifier: string | null
    totalCostAmount: string | null
    labourHours: string | null
    labourPerson: string | null
    labourTask: string | null
    happenedAt: Date | null
    isManual: boolean
    unresolvedFlags: string[]
    budgetCategoryId: string | null
    sourceCandidateFactId: string | null
    reviewDecisionId: string
    createdAt: Date
    updatedAt: Date
  },
  fact: {
    id: string
    sourceNoteId: string
    sourceTranscriptId: string
    uncertaintyFlags: string[]
    sourceNote: { id: string; capturedAt: Date }
    transcript: { id: string; text: string | null } | null
  } | null,
) {
  return {
    id: item.id,
    memoryType: (item.memoryType as string).toLowerCase(),
    summary: item.summary,
    materialName: item.materialName,
    quantity: item.quantity,
    unit: item.unit,
    supplierName: item.supplierName,
    deliveryTiming: item.deliveryTiming,
    locationOrUse: item.locationOrUse,
    costAmount: item.costAmount,
    costCurrency: item.costCurrency,
    costQualifier: item.costQualifier,
    totalCostAmount: item.totalCostAmount,
    labourHours: item.labourHours,
    labourPerson: item.labourPerson,
    labourTask: item.labourTask,
    happenedAt: item.happenedAt,
    isManual: item.isManual,
    budgetCategoryId: item.budgetCategoryId,
    unitCostLabel: formatUnitCostLabel(item.costAmount, item.costCurrency, item.costQualifier),
    lineTotalLabel: formatLineTotalLabel(item.totalCostAmount, item.costCurrency),
    uncertaintyFlags: item.unresolvedFlags,
    sourceUncertaintyFlags: fact?.uncertaintyFlags ?? [],
    sourceCandidateFactId: item.sourceCandidateFactId,
    reviewDecisionId: item.reviewDecisionId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
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
}

// ── Direct add (manual memory) ────────────────────────────────────────────────

export interface CreateMemoryItemInput {
  memoryType: string
  summary?: string | null
  happenedAt?: string | null
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  deliveryTiming?: string | null
  locationOrUse?: string | null
  costAmount?: string | null
  costCurrency?: string | null
  costQualifier?: string | null
  totalCostAmount?: string | null
  labourHours?: string | null
  labourPerson?: string | null
  labourTask?: string | null
  budgetCategoryId?: string | null
}

// Map a lowercase API memory type to its memory-view section key, for the
// ADD_MISSING ReviewDecision audit record.
const MEMORY_TYPE_SECTION_KEY: Record<string, string> = {
  ordered_material: 'ordered_materials',
  used_material: 'used_materials',
  leftover_material: 'leftovers',
  supplier_delivery_note: 'supplier_delivery_notes',
  customer_change: 'customer_changes',
  watch_out: 'watch_outs',
  labour: 'labour',
  general_note: 'general_notes',
}

// Ensure every manual item has a non-empty summary: prefer the submitted text,
// otherwise derive a plain-language one from the section fields.
function deriveManualSummary(input: CreateMemoryItemInput): string | null {
  const explicit = input.summary?.trim()
  if (explicit) return explicit

  const name = input.materialName?.trim()
  const qty = input.quantity?.trim()
  const unit = input.unit?.trim()
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' ').trim()

  switch (input.memoryType) {
    case 'ordered_material':
      return name ? (join('Bought', qty, unit, name) || name) : null
    case 'used_material':
      return name ? (join('Used', qty, unit, name) || name) : null
    case 'leftover_material':
      return name ? (join(qty, unit, name, 'left') || name) : null
    case 'labour': {
      const person = input.labourPerson?.trim()
      const hours = input.labourHours?.trim()
      const task = input.labourTask?.trim()
      const head = [person, hours ? `${hours} hours` : null].filter(Boolean).join(' — ')
      const base = head || (task ? 'Labour' : null)
      if (!base) return null
      return task ? `${base} · ${task}` : base
    }
    default:
      return null
  }
}

export async function createMemoryItem(jobId: string, userId: string, input: CreateMemoryItemInput) {
  await verifyJobOwnership(jobId, userId)

  const memoryType = input.memoryType.toUpperCase()

  const summary = deriveManualSummary(input)
  if (!summary) throw { code: ErrorCode.MISSING_FIELD, message: 'summary is required' }

  const happenedAt = parseHappenedAt(input.happenedAt)

  // Default currency to GBP when a cost is present but currency omitted.
  let costCurrency = input.costCurrency ?? null
  if (!costCurrency && (input.costAmount || input.totalCostAmount)) costCurrency = 'GBP'

  // A stated total (costQualifier 'total') means costAmount is itself the total.
  const totalFromTotalQualifier =
    input.costQualifier === 'total' && input.costAmount && STRICT_DECIMAL_RE.test(input.costAmount)
      ? input.costAmount
      : null

  // Preserve an explicit total, else derive from stated total, material each, or
  // labour per_hour.
  const totalCostAmount =
    input.totalCostAmount ??
    totalFromTotalQualifier ??
    deriveSafeMaterialTotal(input.quantity, input.unit, input.costAmount, costCurrency, input.costQualifier) ??
    deriveSafeLabourTotal(input.labourHours, input.costAmount, input.costQualifier) ??
    null

  const unresolvedFlags =
    hasCostConflict(input.quantity, input.costAmount, input.costQualifier, totalCostAmount)
      ? ['cost_uncertain']
      : []

  // Category is only meaningful for spend and labour.
  let budgetCategoryId: string | null = null
  if (input.budgetCategoryId != null) {
    if (!CATEGORY_ELIGIBLE_TYPES.has(memoryType)) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId is only allowed on ordered_material or labour memory' }
    }
    await assertAssignableCategory(jobId, input.budgetCategoryId)
    budgetCategoryId = input.budgetCategoryId
  }

  const created = await prisma.$transaction(async (tx) => {
    // ADD_MISSING decision keeps the audit trail consistent with reviewed memory.
    const decision = await tx.reviewDecision.create({
      data: {
        jobId,
        decidedBy: userId,
        action: 'ADD_MISSING',
        candidateFactId: null,
        sectionKey: MEMORY_TYPE_SECTION_KEY[input.memoryType] ?? null,
        sourceCandidateFactIds: [],
      },
    })

    return tx.memoryItem.create({
      data: {
        jobId,
        reviewDecisionId: decision.id,
        sourceCandidateFactId: null,
        isManual: true,
        memoryType: memoryType as never,
        summary,
        materialName: input.materialName ?? null,
        quantity: input.quantity ?? null,
        unit: input.unit ?? null,
        supplierName: input.supplierName ?? null,
        deliveryTiming: input.deliveryTiming ?? null,
        locationOrUse: input.locationOrUse ?? null,
        costAmount: input.costAmount ?? null,
        costCurrency,
        costQualifier: input.costQualifier ?? null,
        totalCostAmount,
        labourHours: input.labourHours ?? null,
        labourPerson: input.labourPerson ?? null,
        labourTask: input.labourTask ?? null,
        happenedAt,
        unresolvedFlags,
        budgetCategoryId,
      },
    })
  })

  // Manual memory has no source fact/transcript context.
  return normalizeMemoryItem(created, null)
}
