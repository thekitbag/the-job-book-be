import { createHash } from 'crypto'
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

// ── Section configuration ─────────────────────────────────────────────────────

const FACT_TYPE_TO_SECTION: Record<string, string> = {
  ORDERED_MATERIAL: 'ordered_materials',
  USED_MATERIAL: 'used_materials',
  LEFTOVER_MATERIAL: 'leftovers',
  SUPPLIER_DELIVERY_NOTE: 'supplier_delivery_notes',
  CUSTOMER_CHANGE: 'customer_changes',
  WATCH_OUT: 'watch_outs',
  UNCLEAR: 'unclear_items',
}

const SECTION_LABELS: Record<string, string> = {
  ordered_materials: 'Ordered materials',
  used_materials: 'Used materials',
  leftovers: 'Leftovers',
  supplier_delivery_notes: 'Supplier delivery notes',
  customer_changes: 'Customer changes',
  watch_outs: 'Watch outs',
  unclear_items: 'Unclear items',
}

const SECTION_KEYS = Object.keys(SECTION_LABELS)

const VALID_MEMORY_TYPES = new Set([
  'ordered_material', 'used_material', 'leftover_material',
  'supplier_delivery_note', 'customer_change', 'watch_out',
])

// Stable deterministic ID derived from the job + sorted source fact IDs.
// Same inputs always produce the same ID so GET regenerations never invalidate
// in-flight decision requests from a prior GET.
function computeGroupId(jobId: string, factIds: string[]): string {
  const h = createHash('sha256')
    .update(`${jobId}:${[...factIds].sort().join('|')}`)
    .digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposedMemory {
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
}

interface GroupedItemData {
  sectionKey: string
  kind: 'SINGLE' | 'DUPLICATE_GROUP' | 'CONTRADICTION' | 'UNCLEAR_PROMPT'
  reviewLabel: string
  summary: string
  proposedMemory: ProposedMemory
  confidenceLabel: string
  uncertaintyFlags: string[]
  sourceCandidateFactIds: string[]
}

type FactWithContext = {
  id: string
  factType: string
  status: string
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
  confidenceLabel: string
  uncertaintyFlags: string[]
  sourceNoteId: string
  sourceTranscriptId: string
  sourceNote: { id: string; capturedAt: Date }
  transcript: { id: string; text: string | null }
}

export interface CorrectedFields {
  memoryType: string
  summary: string
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

export type QueueDecisionPayload =
  | { action: 'confirm'; queueItemId: string }
  | { action: 'correct'; queueItemId: string; corrected: CorrectedFields }
  | { action: 'dismiss'; queueItemId: string; reason?: string }

// ── Grouping helpers ──────────────────────────────────────────────────────────

function extractProposedMemory(f: FactWithContext): ProposedMemory {
  return {
    memoryType: f.factType.toLowerCase(),
    summary: f.summary,
    materialName: f.materialName,
    quantity: f.quantity,
    unit: f.unit,
    supplierName: f.supplierName,
    deliveryTiming: f.deliveryTiming,
    locationOrUse: f.locationOrUse,
    costAmount: f.costAmount,
    costCurrency: f.costCurrency,
    costQualifier: f.costQualifier,
    totalCostAmount: f.totalCostAmount,
  }
}

function mostCompleteFact(facts: FactWithContext[]): FactWithContext {
  const score = (f: FactWithContext) =>
    [f.materialName, f.quantity, f.unit, f.supplierName, f.deliveryTiming, f.locationOrUse].filter(
      (v) => v != null,
    ).length
  return facts.reduce((best, f) => (score(f) >= score(best) ? f : best))
}

function unionFlags(facts: FactWithContext[]): string[] {
  return [...new Set(facts.flatMap((f) => f.uncertaintyFlags))]
}

function deriveConfidence(facts: FactWithContext[]): string {
  const labels = facts.map((f) => f.confidenceLabel)
  if (labels.includes('LOW')) return 'low'
  if (labels.every((l) => l === 'HIGH')) return 'high'
  return 'medium'
}

function groupTypedFactsForSection(facts: FactWithContext[], sectionKey: string): GroupedItemData[] {
  const items: GroupedItemData[] = []

  const byName = new Map<string, FactWithContext[]>()
  const unnamed: FactWithContext[] = []

  for (const f of facts) {
    const name = f.materialName?.toLowerCase().trim()
    if (!name) {
      unnamed.push(f)
    } else {
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name)!.push(f)
    }
  }

  for (const [, group] of byName) {
    if (group.length === 1) {
      const f = group[0]
      items.push({
        sectionKey,
        kind: 'SINGLE',
        reviewLabel: '',
        summary: f.summary,
        proposedMemory: extractProposedMemory(f),
        confidenceLabel: f.confidenceLabel.toLowerCase(),
        uncertaintyFlags: f.uncertaintyFlags,
        sourceCandidateFactIds: [f.id],
      })
    } else {
      const quantities = group.map((f) => f.quantity?.trim()).filter((q): q is string => !!q)
      const uniqueQuantities = new Set(quantities)
      const isContradiction = quantities.length >= 2 && uniqueQuantities.size > 1

      if (isContradiction) {
        const representative = mostCompleteFact(group)
        items.push({
          sectionKey,
          kind: 'CONTRADICTION',
          reviewLabel: 'Worth checking',
          summary: `Conflicting information about ${group[0].materialName}`,
          proposedMemory: extractProposedMemory(representative),
          confidenceLabel: 'low',
          uncertaintyFlags: [...new Set([...unionFlags(group), 'conflicting_quantity'])],
          sourceCandidateFactIds: group.map((f) => f.id),
        })
      } else {
        const primary = mostCompleteFact(group)
        items.push({
          sectionKey,
          kind: 'DUPLICATE_GROUP',
          reviewLabel: 'Looks like the same item',
          summary: primary.summary,
          proposedMemory: extractProposedMemory(primary),
          confidenceLabel: deriveConfidence(group),
          uncertaintyFlags: unionFlags(group),
          sourceCandidateFactIds: group.map((f) => f.id),
        })
      }
    }
  }

  for (const f of unnamed) {
    items.push({
      sectionKey,
      kind: 'SINGLE',
      reviewLabel: '',
      summary: f.summary,
      proposedMemory: extractProposedMemory(f),
      confidenceLabel: f.confidenceLabel.toLowerCase(),
      uncertaintyFlags: f.uncertaintyFlags,
      sourceCandidateFactIds: [f.id],
    })
  }

  return items
}

function groupAllFacts(facts: FactWithContext[]): GroupedItemData[] {
  const unclearFacts = facts.filter((f) => f.factType === 'UNCLEAR' || f.status === 'UNCLEAR')
  const typedFacts = facts.filter((f) => f.factType !== 'UNCLEAR' && f.status !== 'UNCLEAR')

  const bySectionKey = new Map<string, FactWithContext[]>()
  for (const key of SECTION_KEYS.filter((k) => k !== 'unclear_items')) bySectionKey.set(key, [])
  for (const f of typedFacts) {
    const key = FACT_TYPE_TO_SECTION[f.factType]
    if (key && bySectionKey.has(key)) bySectionKey.get(key)!.push(f)
  }

  const items: GroupedItemData[] = []
  for (const [sectionKey, sectionFacts] of bySectionKey) {
    items.push(...groupTypedFactsForSection(sectionFacts, sectionKey))
  }

  for (const f of unclearFacts) {
    items.push({
      sectionKey: 'unclear_items',
      kind: 'UNCLEAR_PROMPT',
      reviewLabel: 'Needs clarification',
      summary: f.summary,
      proposedMemory: extractProposedMemory(f),
      confidenceLabel: 'low',
      uncertaintyFlags: f.uncertaintyFlags,
      sourceCandidateFactIds: [f.id],
    })
  }

  return items
}

// ── Time label ────────────────────────────────────────────────────────────────

function computeTimeLabel(timestamp: Date, now: Date): string {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1)
  if (timestamp >= todayStart) return 'Today'
  if (timestamp >= yesterdayStart) return 'Yesterday'
  return 'Earlier'
}

function groupTimeLabel(sourceCandidateFactIds: string[], factMap: Map<string, FactWithContext>, now: Date): string {
  const times = sourceCandidateFactIds
    .map((id) => factMap.get(id)?.sourceNote.capturedAt)
    .filter((d): d is Date => d != null)
  if (times.length === 0) return 'Earlier'
  const mostRecent = new Date(Math.max(...times.map((d) => d.getTime())))
  return computeTimeLabel(mostRecent, now)
}

// ── Access control ────────────────────────────────────────────────────────────

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

// ── Shared queue generation (used by both the review-queue route and inspection) ──

export async function buildFreshQueueSections(jobId: string, now: Date) {
  const facts = await prisma.candidateFact.findMany({
    where: { jobId, status: { in: ['DRAFT', 'UNCLEAR'] } },
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const factMap = new Map(facts.map((f) => [f.id, f]))
  const grouped = groupAllFacts(facts)

  // Assign deterministic IDs so the same grouping always yields the same UUID.
  const itemsWithIds = grouped.map((item) => ({
    id: computeGroupId(jobId, item.sourceCandidateFactIds),
    jobId,
    sectionKey: item.sectionKey,
    kind: item.kind,
    status: 'draft',
    reviewLabel: item.reviewLabel,
    timeLabel: groupTimeLabel(item.sourceCandidateFactIds, factMap, now),
    summary: item.summary,
    proposedMemory: item.proposedMemory as object,
    confidenceLabel: item.confidenceLabel,
    uncertaintyFlags: item.uncertaintyFlags,
    sourceCandidateFactIds: item.sourceCandidateFactIds,
  }))
  const currentIds = itemsWithIds.map((i) => i.id)

  // Remove DRAFT items whose source facts are no longer unresolved.
  // Never touch decided (confirmed/corrected/dismissed) items — they are the audit trail.
  await prisma.queueItem.deleteMany({
    where: currentIds.length > 0
      ? { jobId, status: 'draft', id: { notIn: currentIds } }
      : { jobId, status: 'draft' },
  })

  // Create items that don't exist yet; skip if the stable ID already exists.
  if (itemsWithIds.length > 0) {
    await prisma.queueItem.createMany({ data: itemsWithIds, skipDuplicates: true })
  }

  const queueItems = await prisma.queueItem.findMany({
    where: { jobId, status: 'draft' },
    orderBy: { createdAt: 'asc' },
  })

  const sections = SECTION_KEYS.map((key) => ({
    key,
    label: SECTION_LABELS[key],
    items: queueItems
      .filter((item) => item.sectionKey === key)
      .map((item) => ({
        id: item.id,
        kind: item.kind.toLowerCase(),
        status: item.status,
        reviewLabel: item.reviewLabel,
        timeLabel: item.timeLabel,
        summary: item.summary,
        proposedMemory: item.proposedMemory,
        confidenceLabel: item.confidenceLabel,
        uncertaintyFlags: item.uncertaintyFlags,
        sourceCandidateFactIds: item.sourceCandidateFactIds,
      })),
  }))

  return { sections, factMap }
}

// ── GET /api/jobs/:jobId/review-queue ─────────────────────────────────────────

export async function getReviewQueue(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const now = new Date()

  const { sections: baseSections, factMap } = await buildFreshQueueSections(jobId, now)

  // Add sourceContext to each item using the factMap (review-queue-specific enrichment)
  const sections = baseSections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({
      ...item,
      sourceContext: item.sourceCandidateFactIds.flatMap((id) => {
        const f = factMap.get(id)
        if (!f) return []
        return [{
          candidateFactId: f.id,
          noteId: f.sourceNoteId,
          transcriptId: f.sourceTranscriptId,
          capturedAt: f.sourceNote.capturedAt,
          transcriptText: f.transcript.text ?? null,
        }]
      }),
    })),
  }))

  const memoryItems = await prisma.memoryItem.findMany({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
  })

  const alreadyRemembered = memoryItems.map((m) => ({
    memoryItemId: m.id,
    summary: m.summary,
    memoryType: m.memoryType.toLowerCase(),
    timeLabel: computeTimeLabel(m.createdAt, now),
  }))

  return { jobId, generatedAt: now, sections, alreadyRemembered }
}

// ── POST /api/jobs/:jobId/review-queue-decisions ──────────────────────────────

export async function submitQueueDecision(jobId: string, userId: string, payload: QueueDecisionPayload) {
  await verifyJobOwnership(jobId, userId)

  const item = await prisma.queueItem.findFirst({
    where: { id: payload.queueItemId, jobId },
  })

  if (!item) throw { code: ErrorCode.QUEUE_ITEM_NOT_FOUND, message: 'Queue item not found' }

  if (item.status !== 'draft') {
    throw {
      code: ErrorCode.QUEUE_ITEM_ALREADY_DECIDED,
      message: `Item has already been decided (status: ${item.status})`,
    }
  }

  if (payload.action === 'confirm' && (item.kind === 'CONTRADICTION' || item.kind === 'UNCLEAR_PROMPT')) {
    throw {
      code: ErrorCode.QUEUE_ITEM_CONFIRM_NOT_ALLOWED,
      message: 'Contradictions and unclear items must be corrected or dismissed',
    }
  }

  const pm = item.proposedMemory as unknown as ProposedMemory
  const sourceCandidateFactIds = item.sourceCandidateFactIds

  if (payload.action === 'confirm') {
    const result = await prisma.$transaction(async (tx) => {
      await tx.queueItem.update({ where: { id: item.id }, data: { status: 'confirmed' } })

      const decision = await tx.reviewDecision.create({
        data: {
          jobId,
          decidedBy: userId,
          action: 'QUEUE_CONFIRM',
          candidateFactId: sourceCandidateFactIds[0] ?? null,
          sourceCandidateFactIds,
        },
      })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          reviewDecisionId: decision.id,
          sourceCandidateFactId: sourceCandidateFactIds[0] ?? null,
          memoryType: (pm.memoryType.toUpperCase()) as never,
          isManual: false,
          summary: pm.summary,
          materialName: pm.materialName,
          quantity: pm.quantity,
          unit: pm.unit,
          supplierName: pm.supplierName,
          deliveryTiming: pm.deliveryTiming,
          locationOrUse: pm.locationOrUse,
          costAmount: pm.costAmount,
          costCurrency: pm.costCurrency,
          costQualifier: pm.costQualifier,
          totalCostAmount: pm.totalCostAmount,
        },
      })

      await tx.candidateFact.updateMany({
        where: { id: { in: sourceCandidateFactIds } },
        data: { status: 'CONFIRMED' },
      })

      return memoryItem
    })

    return {
      queueItemId: item.id,
      action: 'confirm',
      status: 'confirmed',
      memoryItemId: result.id,
      sourceCandidateFactIds,
    }
  }

  if (payload.action === 'correct') {
    const { corrected } = payload
    const memoryType = (corrected.memoryType.toUpperCase()) as never

    const result = await prisma.$transaction(async (tx) => {
      await tx.queueItem.update({ where: { id: item.id }, data: { status: 'corrected' } })

      const decision = await tx.reviewDecision.create({
        data: {
          jobId,
          decidedBy: userId,
          action: 'QUEUE_CORRECT',
          candidateFactId: sourceCandidateFactIds[0] ?? null,
          sourceCandidateFactIds,
        },
      })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          reviewDecisionId: decision.id,
          sourceCandidateFactId: sourceCandidateFactIds[0] ?? null,
          memoryType,
          isManual: false,
          summary: corrected.summary,
          materialName: corrected.materialName ?? null,
          quantity: corrected.quantity ?? null,
          unit: corrected.unit ?? null,
          supplierName: corrected.supplierName ?? null,
          deliveryTiming: corrected.deliveryTiming ?? null,
          locationOrUse: corrected.locationOrUse ?? null,
          costAmount: corrected.costAmount ?? null,
          costCurrency: corrected.costCurrency ?? null,
          costQualifier: corrected.costQualifier ?? null,
          totalCostAmount: corrected.totalCostAmount ?? null,
        },
      })

      await tx.candidateFact.updateMany({
        where: { id: { in: sourceCandidateFactIds } },
        data: { status: 'CORRECTED' },
      })

      return memoryItem
    })

    return {
      queueItemId: item.id,
      action: 'correct',
      status: 'corrected',
      memoryItemId: result.id,
      sourceCandidateFactIds,
    }
  }

  // dismiss
  await prisma.$transaction(async (tx) => {
    await tx.queueItem.update({ where: { id: item.id }, data: { status: 'dismissed' } })

    await tx.reviewDecision.create({
      data: {
        jobId,
        decidedBy: userId,
        action: 'QUEUE_DISMISS',
        candidateFactId: sourceCandidateFactIds[0] ?? null,
        reason: payload.reason ?? null,
        sourceCandidateFactIds,
      },
    })

    await tx.candidateFact.updateMany({
      where: { id: { in: sourceCandidateFactIds } },
      data: { status: 'REJECTED' },
    })
  })

  return {
    queueItemId: item.id,
    action: 'dismiss',
    status: 'dismissed',
    memoryItemId: null,
    sourceCandidateFactIds,
  }
}

export { VALID_MEMORY_TYPES }
