import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import {
  STRICT_DECIMAL_RE,
  deriveSafeMaterialTotal,
  deriveSafeLabourTotal,
  hasCostConflict,
  formatUnitCostLabel,
  formatLineTotalLabel,
  formatRefundLabel,
  strictParsePositive,
} from '../lib/cost-utils.js'
import { assertAssignableCategory } from './budget.js'
import { isCategoryAssignableMemoryType, sectionKeyForApiMemoryType } from '../lib/memory-types.js'
import { ukLocalNoon } from '../lib/dates.js'
import { refundMoneyEventData } from './money.js'
import { requireOwnedLabourPerson } from './labour-people.js'

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
}

// Parse an optional ISO date/time string to a Date, rejecting invalid input.
// A date-only value (YYYY-MM-DD) is stored as UK local noon so the intended
// day never drifts across timezones.
function parseHappenedAt(value: string | null | undefined): Date | null {
  if (value == null || value === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return ukLocalNoon(value)
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
  labourPersonId?: string | null
  labourBudgetEnabled?: boolean | null
  happenedAt?: string | null
  uncertaintyResolution?: 'resolved' | 'still_unsure'
  budgetCategoryId?: string | null
}

// Resolve the labourPersonId + labourBudgetEnabled to persist on a patch, without
// applying person defaults (a plain person change must not silently rewrite cost
// or Budget treatment — the caller sends those explicitly). Off-labour memory
// never carries these fields. Validates person ownership when a link is set.
async function resolveLabourEntryPatch(
  userId: string,
  finalIsLabour: boolean,
  patch: MemoryItemPatch,
  existing: { labourPersonId: string | null; labourBudgetEnabled: boolean | null },
): Promise<{ labourPersonId: string | null; labourBudgetEnabled: boolean | null }> {
  if (!finalIsLabour) return { labourPersonId: null, labourBudgetEnabled: null }

  let labourPersonId = existing.labourPersonId
  if ('labourPersonId' in patch) {
    if (patch.labourPersonId == null) {
      labourPersonId = null
    } else {
      const person = await requireOwnedLabourPerson(userId, patch.labourPersonId)
      labourPersonId = person.id
    }
  }

  let labourBudgetEnabled = existing.labourBudgetEnabled
  if ('labourBudgetEnabled' in patch) {
    labourBudgetEnabled = patch.labourBudgetEnabled ?? null
  }

  return { labourPersonId, labourBudgetEnabled }
}

export async function patchMemoryItem(
  jobId: string,
  memoryItemId: string,
  userId: string,
  patch: MemoryItemPatch,
) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.memoryItem.findFirst({
    where: { id: memoryItemId, jobId, isRemoved: false },
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
      if (!isCategoryAssignableMemoryType(finalMemoryType)) {
        throw { code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId is only allowed on ordered_material or labour memory' }
      }
      await assertAssignableCategory(jobId, patch.budgetCategoryId)
      budgetCategoryId = patch.budgetCategoryId
    }
  }

  // If the memory type is (or becomes) category-ineligible, a preserved category
  // is cleared so trusted memory never carries a category on the wrong type.
  if (budgetCategoryId !== null && !isCategoryAssignableMemoryType(finalMemoryType)) {
    budgetCategoryId = null
  }

  const finalIsLabour = finalMemoryType === 'LABOUR'
  // labourBudgetEnabled is meaningful only for labour memory.
  if ('labourBudgetEnabled' in patch && patch.labourBudgetEnabled != null && !finalIsLabour) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'labourBudgetEnabled is only allowed on labour memory' }
  }

  // Light change: no memoryType means update only the budget category and/or the
  // labour person link / Budget treatment, leaving every other memory field
  // untouched (used by the entry drawer's "counts toward budget" toggle).
  if (patch.memoryType == null) {
    const touchesLabour = 'labourPersonId' in patch || 'labourBudgetEnabled' in patch
    const labourData = touchesLabour
      ? await resolveLabourEntryPatch(userId, finalIsLabour, patch, existing)
      : {}
    const updated = await prisma.memoryItem.update({
      where: { id: memoryItemId },
      data: { budgetCategoryId, ...labourData },
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

  const labourData = await resolveLabourEntryPatch(userId, finalIsLabour, patch, existing)

  const updated = await prisma.memoryItem.update({
    where: { id: memoryItemId },
    data: {
      memoryType: patch.memoryType.toUpperCase() as never,
      budgetCategoryId,
      ...labourData,
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

// Soft-remove a confirmed memory item from the active job record. The row is
// never hard-deleted and source note/audio/transcript/candidate fact/review
// decision are untouched — only active views stop showing it.
export async function removeMemoryItem(jobId: string, memoryItemId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.memoryItem.findFirst({
    where: { id: memoryItemId, jobId, isRemoved: false },
  })
  if (!existing) throw { code: ErrorCode.MEMORY_ITEM_NOT_FOUND, message: 'Memory item not found' }

  await prisma.memoryItem.update({
    where: { id: memoryItemId },
    data: { isRemoved: true, removedAt: new Date(), removedByUserId: userId },
  })
}

// Include shape shared by the return operation's re-reads so both the returned
// item and any remaining leftover normalize with full source context.
const FACT_INCLUDE = {
  sourceFact: {
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
  },
} as const

export interface ReturnMaterialInput {
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  refundAmount?: string | null
  refundCurrency?: string | null
  happenedAt?: string | null
}

// Trim a decimal to a stable string (drops floating-point dust from subtraction).
function formatQuantity(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

// Plain-language summary for a returned item: "Returned 4 sheets OSB to Jewson · £80 refund".
function deriveReturnSummary(
  materialName: string | null,
  quantity: string,
  unit: string | null,
  supplierName: string | null,
  refundLabel: string | null,
): string {
  const head = ['Returned', quantity, unit, materialName].filter(Boolean).join(' ').trim()
  const withSupplier = supplierName ? `${head} to ${supplierName}` : head
  return refundLabel ? `${withSupplier} · ${refundLabel}` : withSupplier
}

// Return all or part of a Left over item to a merchant. Creates a trusted
// RETURNED_MATERIAL memory item for the returned quantity and either soft-removes
// (full) or reduces (partial) the source leftover — transactionally, so active
// Left over and Returned can never disagree. Source evidence is preserved: the
// original leftover row (and its note/transcript/fact chain) is never deleted.
export async function returnMaterial(
  jobId: string,
  memoryItemId: string,
  userId: string,
  input: ReturnMaterialInput,
) {
  await verifyJobOwnership(jobId, userId)

  const source = await prisma.memoryItem.findFirst({
    where: { id: memoryItemId, jobId, isRemoved: false },
  })
  if (!source) throw { code: ErrorCode.MEMORY_ITEM_NOT_FOUND, message: 'Memory item not found' }
  if (source.memoryType !== 'LEFTOVER_MATERIAL') {
    throw { code: ErrorCode.INVALID_FIELD, message: 'Only a leftover_material item can be returned' }
  }

  // Returned quantity: required, strict positive decimal.
  const returnedQtyStr = input.quantity ?? null
  const returnedQty = strictParsePositive(returnedQtyStr)
  if (returnedQtyStr == null || returnedQty === null || returnedQty <= 0) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'quantity must be a positive decimal string' }
  }

  // Compare against the active leftover quantity. If the leftover quantity is
  // missing or non-numeric, a safe comparison is impossible — reject rather than
  // guess (never allow a silent over-return).
  const leftoverQty = strictParsePositive(source.quantity)
  if (leftoverQty === null) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'leftover quantity is not a number; cannot return safely' }
  }
  if (returnedQty > leftoverQty) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'returned quantity exceeds remaining leftover quantity' }
  }

  // Refund is optional; when present it must be a strict positive decimal and GBP.
  let refundAmount: string | null = null
  let refundCurrency: string | null = null
  if (input.refundAmount != null && input.refundAmount !== '') {
    const parsed = strictParsePositive(input.refundAmount)
    if (parsed === null || parsed <= 0) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'refundAmount must be a positive decimal string' }
    }
    if (input.refundCurrency != null && input.refundCurrency !== 'GBP') {
      throw { code: ErrorCode.INVALID_FIELD, message: 'refundCurrency must be GBP' }
    }
    refundAmount = input.refundAmount
    refundCurrency = input.refundCurrency ?? 'GBP'
  }

  const unit = input.unit !== undefined && input.unit !== null && input.unit !== ''
    ? input.unit
    : source.unit
  const supplierName = input.supplierName?.trim() ? input.supplierName.trim() : null
  const happenedAt = parseHappenedAt(input.happenedAt)
  const summary = deriveReturnSummary(
    source.materialName,
    returnedQtyStr,
    unit,
    supplierName,
    formatRefundLabel(refundAmount, refundCurrency),
  )

  const isFullReturn = returnedQty === leftoverQty

  const { returnedItem, remainingLeftover } = await prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: {
        jobId,
        decidedBy: userId,
        action: 'ADD_MISSING',
        candidateFactId: null,
        sectionKey: 'returned_materials',
        sourceCandidateFactIds: [],
      },
    })

    const returnedItem = await tx.memoryItem.create({
      data: {
        jobId,
        reviewDecisionId: decision.id,
        sourceCandidateFactId: null,
        isManual: true,
        memoryType: 'RETURNED_MATERIAL',
        summary,
        materialName: source.materialName,
        quantity: returnedQtyStr,
        unit,
        supplierName,
        happenedAt,
        refundAmount,
        refundCurrency,
        returnedFromMemoryItemId: source.id,
      },
      include: FACT_INCLUDE,
    })

    // Money in: a trusted GBP refund records a REFUND money event linked to the
    // returned item (in the same transaction, so Money and the return commit
    // together). No trusted refund → no Money movement. The partial unique index
    // prevents a duplicate active refund for this returned item.
    if (refundAmount !== null && refundCurrency === 'GBP') {
      await tx.jobMoneyEvent.create({
        data: refundMoneyEventData(jobId, returnedItem.id, refundAmount, happenedAt ?? new Date()),
      })
    }

    let remainingLeftover = null
    if (isFullReturn) {
      // Full return: the source leftover is fully consumed. Soft-remove it (source
      // evidence preserved) with a reason distinguishing it from a plain delete.
      await tx.memoryItem.update({
        where: { id: source.id },
        data: { isRemoved: true, removedAt: new Date(), removedByUserId: userId, removedReason: 'returned' },
      })
    } else {
      // Partial return: the source leftover keeps its remaining quantity.
      remainingLeftover = await tx.memoryItem.update({
        where: { id: source.id },
        data: { quantity: formatQuantity(leftoverQty - returnedQty) },
        include: FACT_INCLUDE,
      })
    }

    return { returnedItem, remainingLeftover }
  })

  return {
    returnedItem: normalizeMemoryItem(returnedItem, returnedItem.sourceFact ?? null),
    remainingLeftoverItem: remainingLeftover
      ? normalizeMemoryItem(remainingLeftover, remainingLeftover.sourceFact ?? null)
      : null,
  }
}

export async function verifyMemoryItem(jobId: string, memoryItemId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const existing = await prisma.memoryItem.findFirst({ where: { id: memoryItemId, jobId, isRemoved: false } })
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
    labourPersonId: string | null
    labourBudgetEnabled: boolean | null
    happenedAt: Date | null
    isManual: boolean
    unresolvedFlags: string[]
    budgetCategoryId: string | null
    returnedFromMemoryItemId: string | null
    refundAmount: string | null
    refundCurrency: string | null
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
    labourPersonId: item.labourPersonId,
    labourBudgetEnabled: item.labourBudgetEnabled,
    happenedAt: item.happenedAt,
    isManual: item.isManual,
    budgetCategoryId: item.budgetCategoryId,
    returnedFromMemoryItemId: item.returnedFromMemoryItemId,
    refundAmount: item.refundAmount,
    refundCurrency: item.refundCurrency,
    refundLabel: formatRefundLabel(item.refundAmount, item.refundCurrency),
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
  labourPersonId?: string | null
  labourBudgetEnabled?: boolean | null
  budgetCategoryId?: string | null
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
    case 'returned_material':
      return name ? (join('Returned', qty, unit, name) || name) : null
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
  const isLabour = memoryType === 'LABOUR'

  // Labour person + Budget-treatment defaulting (new labour entries only). A
  // selected person can fill in the assumed rate, the person's display name, and
  // the default Budget treatment when the request omits them; a request that
  // sends those fields always wins. No person/default → hours-only, never hidden
  // Budget cost.
  let personId: string | null = null
  let effCostAmount = input.costAmount
  let effCostCurrency = input.costCurrency
  let effCostQualifier = input.costQualifier
  let effLabourPerson = input.labourPerson
  let labourBudgetEnabled: boolean | null = null
  if (isLabour) {
    const person = input.labourPersonId ? await requireOwnedLabourPerson(userId, input.labourPersonId) : null
    personId = person?.id ?? null

    const rateOmitted = !('costAmount' in input) && !('totalCostAmount' in input)
    if (person && rateOmitted && person.defaultHourlyRateAmount) {
      effCostAmount = person.defaultHourlyRateAmount
      effCostCurrency = 'GBP'
      effCostQualifier = 'per_hour'
    }
    if (person && (effLabourPerson == null || effLabourPerson.trim() === '')) {
      effLabourPerson = person.name
    }
    if (input.labourBudgetEnabled === true || input.labourBudgetEnabled === false) {
      labourBudgetEnabled = input.labourBudgetEnabled
    } else if (person) {
      labourBudgetEnabled = person.defaultBudgetTreatment === 'COUNTS_TOWARD_BUDGET'
    } else {
      labourBudgetEnabled = false
    }
  }

  const summary = deriveManualSummary({ ...input, labourPerson: effLabourPerson })
  if (!summary) throw { code: ErrorCode.MISSING_FIELD, message: 'summary is required' }

  const happenedAt = parseHappenedAt(input.happenedAt)

  // Default currency to GBP when a cost is present but currency omitted.
  let costCurrency = effCostCurrency ?? null
  if (!costCurrency && (effCostAmount || input.totalCostAmount)) costCurrency = 'GBP'

  // A stated total (costQualifier 'total') means costAmount is itself the total.
  const totalFromTotalQualifier =
    effCostQualifier === 'total' && effCostAmount && STRICT_DECIMAL_RE.test(effCostAmount)
      ? effCostAmount
      : null

  // Preserve an explicit total, else derive from stated total, material each, or
  // labour per_hour.
  const totalCostAmount =
    input.totalCostAmount ??
    totalFromTotalQualifier ??
    deriveSafeMaterialTotal(input.quantity, input.unit, effCostAmount, costCurrency, effCostQualifier) ??
    deriveSafeLabourTotal(input.labourHours, effCostAmount, effCostQualifier) ??
    null

  const unresolvedFlags =
    hasCostConflict(input.quantity, effCostAmount, effCostQualifier, totalCostAmount)
      ? ['cost_uncertain']
      : []

  // Category is only meaningful for spend and labour.
  let budgetCategoryId: string | null = null
  if (input.budgetCategoryId != null) {
    if (!isCategoryAssignableMemoryType(memoryType)) {
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
        // Section key for the ADD_MISSING ReviewDecision audit record.
        sectionKey: sectionKeyForApiMemoryType(input.memoryType),
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
        costAmount: effCostAmount ?? null,
        costCurrency,
        costQualifier: effCostQualifier ?? null,
        totalCostAmount,
        labourHours: input.labourHours ?? null,
        labourPerson: effLabourPerson ?? null,
        labourTask: input.labourTask ?? null,
        labourPersonId: personId,
        labourBudgetEnabled,
        happenedAt,
        unresolvedFlags,
        budgetCategoryId,
      },
    })
  })

  // Manual memory has no source fact/transcript context.
  return normalizeMemoryItem(created, null)
}
