import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

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

  const updated = await prisma.memoryItem.update({
    where: { id: memoryItemId },
    data: {
      memoryType: patch.memoryType.toUpperCase() as never,
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
      totalCostAmount: 'totalCostAmount' in patch ? patch.totalCostAmount ?? null : existing.totalCostAmount,
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
  return {
    id: updated.id,
    memoryType: (updated.memoryType as string).toLowerCase(),
    summary: updated.summary,
    materialName: updated.materialName,
    quantity: updated.quantity,
    unit: updated.unit,
    supplierName: updated.supplierName,
    deliveryTiming: updated.deliveryTiming,
    locationOrUse: updated.locationOrUse,
    costAmount: updated.costAmount,
    costCurrency: updated.costCurrency,
    costQualifier: updated.costQualifier,
    totalCostAmount: updated.totalCostAmount,
    uncertaintyFlags: fact?.uncertaintyFlags ?? [],
    sourceCandidateFactId: updated.sourceCandidateFactId,
    reviewDecisionId: updated.reviewDecisionId,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
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
