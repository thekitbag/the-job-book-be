import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { buildFreshQueueSections } from './review-queue.js'

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
    const sectionItems = (bySection.get(key) ?? []).map((m) => ({
      materialName: m.materialName,
      quantity: m.quantity,
      unit: m.unit,
      supplierName: m.supplierName,
      costLabel: formatCostLabel(m.costAmount, m.costCurrency, m.costQualifier),
      totalCostLabel: formatTotalCostLabel(m.totalCostAmount, m.costCurrency),
      uncertaintyFlags: m.sourceFact?.uncertaintyFlags ?? [],
      memoryItemIds: [m.id],
    }))
    return { key, label: SUMMARY_SECTION_LABELS[key], items: sectionItems }
  })

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
    stillToCheck: {
      count: stillToCheckItems.length,
      items: stillToCheckItems,
    },
  }
}
