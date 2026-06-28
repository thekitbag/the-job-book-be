import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import {
  deriveSafeLineTotal,
  hasCostConflict,
  formatUnitCostLabel,
  formatLineTotalLabel,
} from '../lib/cost-utils.js'
import { assertAssignableCategory } from './budget.js'

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
}

export interface MemoryItemPatch {
  memoryType: string
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

  // Effective cost fields after merging patch with existing
  const effQty = 'quantity' in patch ? (patch.quantity ?? null) : existing.quantity
  const effCostAmount = 'costAmount' in patch ? (patch.costAmount ?? null) : existing.costAmount
  const effCostCurrency = 'costCurrency' in patch ? (patch.costCurrency ?? null) : existing.costCurrency
  const effCostQualifier = 'costQualifier' in patch ? (patch.costQualifier ?? null) : existing.costQualifier

  // Re-derive safe line total from effective fields
  const derived = deriveSafeLineTotal(effQty, effCostAmount, effCostQualifier)

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

  // Category assignment: undefined preserves, null clears, a string must reference
  // a non-archived category in this same job.
  let budgetCategoryId = existing.budgetCategoryId
  if (patch.budgetCategoryId !== undefined) {
    if (patch.budgetCategoryId === null) {
      budgetCategoryId = null
    } else {
      await assertAssignableCategory(jobId, patch.budgetCategoryId)
      budgetCategoryId = patch.budgetCategoryId
    }
  }

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
