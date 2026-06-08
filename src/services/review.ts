import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

const SECTION_TO_FACT_TYPE: Record<string, string> = {
  ordered_materials: 'ORDERED_MATERIAL',
  used_materials: 'USED_MATERIAL',
  leftovers: 'LEFTOVER_MATERIAL',
  supplier_delivery_notes: 'SUPPLIER_DELIVERY_NOTE',
  customer_changes: 'CUSTOMER_CHANGE',
  watch_outs: 'WATCH_OUT',
  unclear_items: 'UNCLEAR',
}

const FACT_TYPE_TO_SECTION: Record<string, string> = Object.fromEntries(
  Object.entries(SECTION_TO_FACT_TYPE).map(([k, v]) => [v, k]),
)

const SECTION_LABELS: Record<string, string> = {
  ordered_materials: 'Ordered materials',
  used_materials: 'Used materials',
  leftovers: 'Leftovers',
  supplier_delivery_notes: 'Supplier delivery notes',
  customer_changes: 'Customer changes',
  watch_outs: 'Watch outs',
  unclear_items: 'Unclear items',
}

const SECTION_KEYS = Object.keys(SECTION_TO_FACT_TYPE)

const REVIEWED_STATUSES = new Set(['CONFIRMED', 'CORRECTED', 'REJECTED', 'SUPERSEDED'])

function formatReviewFact(f: {
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
  confidenceLabel: string
  confidenceReason: string
  uncertaintyFlags: string[]
}) {
  return {
    id: f.id,
    factType: f.factType.toLowerCase(),
    status: f.status.toLowerCase(),
    summary: f.summary,
    materialName: f.materialName,
    quantity: f.quantity,
    unit: f.unit,
    supplierName: f.supplierName,
    deliveryTiming: f.deliveryTiming,
    locationOrUse: f.locationOrUse,
    confidenceLabel: f.confidenceLabel.toLowerCase(),
    confidenceReason: f.confidenceReason,
    uncertaintyFlags: f.uncertaintyFlags,
  }
}

function formatMemoryItem(m: {
  id: string
  jobId: string
  reviewDecisionId: string
  sourceCandidateFactId: string | null
  memoryType: string
  isManual: boolean
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  deliveryTiming: string | null
  locationOrUse: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: m.id,
    jobId: m.jobId,
    memoryType: m.memoryType.toLowerCase(),
    isManual: m.isManual,
    summary: m.summary,
    materialName: m.materialName,
    quantity: m.quantity,
    unit: m.unit,
    supplierName: m.supplierName,
    deliveryTiming: m.deliveryTiming,
    locationOrUse: m.locationOrUse,
    sourceCandidateFactId: m.sourceCandidateFactId,
    reviewDecisionId: m.reviewDecisionId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

async function loadFactForDecision(jobId: string, candidateFactId: string) {
  const fact = await prisma.candidateFact.findUnique({ where: { id: candidateFactId } })
  if (!fact || fact.jobId !== jobId) {
    throw { code: ErrorCode.CANDIDATE_FACT_NOT_FOUND, message: 'Candidate fact not found' }
  }
  if (REVIEWED_STATUSES.has(fact.status)) {
    throw { code: ErrorCode.ALREADY_REVIEWED, message: `Candidate fact has already been reviewed (status: ${fact.status.toLowerCase()})` }
  }
  return fact
}

// GET /api/jobs/:jobId/review-draft
export async function getReviewDraft(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const facts = await prisma.candidateFact.findMany({
    where: { jobId, status: { in: ['DRAFT', 'UNCLEAR'] } },
    include: {
      sourceNote: { select: { capturedAt: true } },
      transcript: { select: { text: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const bySection: Record<string, typeof facts> = {}
  for (const key of SECTION_KEYS) bySection[key] = []

  for (const f of facts) {
    const sectionKey = FACT_TYPE_TO_SECTION[f.factType] ?? 'unclear_items'
    bySection[sectionKey].push(f)
  }

  return {
    jobId,
    groups: SECTION_KEYS.map((key) => ({
      key,
      label: SECTION_LABELS[key],
      items: bySection[key].map((f) => ({
        candidateFact: formatReviewFact(f),
        source: {
          noteId: f.sourceNoteId,
          transcriptId: f.sourceTranscriptId,
          capturedAt: f.sourceNote.capturedAt,
          transcriptText: f.transcript.text ?? null,
        },
      })),
    })),
  }
}

// POST confirm
async function confirmFact(jobId: string, userId: string, candidateFactId: string) {
  const fact = await loadFactForDecision(jobId, candidateFactId)

  if (fact.status === 'UNCLEAR') {
    throw { code: ErrorCode.ALREADY_REVIEWED, message: 'Unclear facts must be corrected or rejected, not confirmed as-is' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: { jobId, decidedBy: userId, action: 'CONFIRM', candidateFactId },
    })
    const memoryItem = await tx.memoryItem.create({
      data: {
        jobId,
        reviewDecisionId: decision.id,
        sourceCandidateFactId: fact.id,
        memoryType: fact.factType,
        isManual: false,
        summary: fact.summary,
        materialName: fact.materialName,
        quantity: fact.quantity,
        unit: fact.unit,
        supplierName: fact.supplierName,
        deliveryTiming: fact.deliveryTiming,
        locationOrUse: fact.locationOrUse,
      },
    })
    await tx.candidateFact.update({ where: { id: fact.id }, data: { status: 'CONFIRMED' } })
    return { decision, memoryItem }
  })

  return {
    action: 'confirm',
    candidateFact: { id: fact.id, status: 'confirmed' },
    memoryItem: formatMemoryItem(result.memoryItem),
  }
}

interface CorrectedFields {
  summary: string
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  deliveryTiming?: string | null
  locationOrUse?: string | null
}

// POST correct
async function correctFact(
  jobId: string,
  userId: string,
  candidateFactId: string,
  corrected: CorrectedFields,
) {
  const fact = await loadFactForDecision(jobId, candidateFactId)

  const result = await prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: { jobId, decidedBy: userId, action: 'CORRECT', candidateFactId },
    })
    const memoryItem = await tx.memoryItem.create({
      data: {
        jobId,
        reviewDecisionId: decision.id,
        sourceCandidateFactId: fact.id,
        memoryType: fact.factType,
        isManual: false,
        summary: corrected.summary,
        materialName: corrected.materialName ?? null,
        quantity: corrected.quantity ?? null,
        unit: corrected.unit ?? null,
        supplierName: corrected.supplierName ?? null,
        deliveryTiming: corrected.deliveryTiming ?? null,
        locationOrUse: corrected.locationOrUse ?? null,
      },
    })
    await tx.candidateFact.update({ where: { id: fact.id }, data: { status: 'CORRECTED' } })
    return { decision, memoryItem }
  })

  return {
    action: 'correct',
    candidateFact: { id: fact.id, status: 'corrected' },
    memoryItem: formatMemoryItem(result.memoryItem),
  }
}

// POST reject
async function rejectFact(
  jobId: string,
  userId: string,
  candidateFactId: string,
  reason?: string,
) {
  const fact = await loadFactForDecision(jobId, candidateFactId)

  await prisma.$transaction(async (tx) => {
    await tx.reviewDecision.create({
      data: { jobId, decidedBy: userId, action: 'REJECT', candidateFactId, reason: reason ?? null },
    })
    await tx.candidateFact.update({ where: { id: fact.id }, data: { status: 'REJECTED' } })
  })

  return {
    action: 'reject',
    candidateFact: { id: fact.id, status: 'rejected' },
  }
}

// POST confirm_section
async function confirmSection(
  jobId: string,
  userId: string,
  sectionKey: string,
  candidateFactIds: string[],
) {
  const expectedFactType = SECTION_TO_FACT_TYPE[sectionKey]
  if (!expectedFactType) {
    throw { code: ErrorCode.MISSING_FIELD, message: `Unknown section key: ${sectionKey}` }
  }

  // Load all requested facts for this job in one query
  const facts = await prisma.candidateFact.findMany({
    where: { id: { in: candidateFactIds }, jobId },
  })

  const factsById = new Map(facts.map((f) => [f.id, f]))

  const toConfirm: typeof facts = []
  const skipped: Array<{ candidateFactId: string; reason: string }> = []

  for (const id of candidateFactIds) {
    const f = factsById.get(id)
    if (!f) {
      skipped.push({ candidateFactId: id, reason: 'not_found' })
      continue
    }
    if (REVIEWED_STATUSES.has(f.status)) {
      skipped.push({ candidateFactId: id, reason: 'already_reviewed' })
      continue
    }
    if (f.status === 'UNCLEAR') {
      skipped.push({ candidateFactId: id, reason: 'unclear' })
      continue
    }
    if (f.factType !== expectedFactType) {
      skipped.push({ candidateFactId: id, reason: 'wrong_section' })
      continue
    }
    toConfirm.push(f)
  }

  const confirmed: Array<{ candidateFactId: string; memoryItemId: string }> = []

  if (toConfirm.length > 0) {
    await prisma.$transaction(async (tx) => {
      const decision = await tx.reviewDecision.create({
        data: { jobId, decidedBy: userId, action: 'CONFIRM_SECTION', sectionKey },
      })
      for (const f of toConfirm) {
        const memoryItem = await tx.memoryItem.create({
          data: {
            jobId,
            reviewDecisionId: decision.id,
            sourceCandidateFactId: f.id,
            memoryType: f.factType,
            isManual: false,
            summary: f.summary,
            materialName: f.materialName,
            quantity: f.quantity,
            unit: f.unit,
            supplierName: f.supplierName,
            deliveryTiming: f.deliveryTiming,
            locationOrUse: f.locationOrUse,
          },
        })
        await tx.candidateFact.update({ where: { id: f.id }, data: { status: 'CONFIRMED' } })
        confirmed.push({ candidateFactId: f.id, memoryItemId: memoryItem.id })
      }
    })
  }

  return { action: 'confirm_section', sectionKey, confirmed, skipped }
}

interface ManualMemoryFields {
  summary: string
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  deliveryTiming?: string | null
  locationOrUse?: string | null
}

// POST add_missing
async function addMissing(
  jobId: string,
  userId: string,
  memoryType: string,
  memory: ManualMemoryFields,
) {
  const dbMemoryType = memoryType.toUpperCase() as never

  const result = await prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: { jobId, decidedBy: userId, action: 'ADD_MISSING' },
    })
    const memoryItem = await tx.memoryItem.create({
      data: {
        jobId,
        reviewDecisionId: decision.id,
        sourceCandidateFactId: null,
        memoryType: dbMemoryType,
        isManual: true,
        summary: memory.summary,
        materialName: memory.materialName ?? null,
        quantity: memory.quantity ?? null,
        unit: memory.unit ?? null,
        supplierName: memory.supplierName ?? null,
        deliveryTiming: memory.deliveryTiming ?? null,
        locationOrUse: memory.locationOrUse ?? null,
      },
    })
    return { memoryItem }
  })

  return {
    action: 'add_missing',
    memoryItem: formatMemoryItem(result.memoryItem),
  }
}

export type ReviewDecisionPayload =
  | { action: 'confirm'; candidateFactId: string }
  | { action: 'correct'; candidateFactId: string; corrected: CorrectedFields }
  | { action: 'reject'; candidateFactId: string; reason?: string }
  | { action: 'confirm_section'; sectionKey: string; candidateFactIds: string[] }
  | { action: 'add_missing'; memoryType: string; memory: ManualMemoryFields }

export async function submitReviewDecision(
  jobId: string,
  userId: string,
  payload: ReviewDecisionPayload,
) {
  await verifyJobOwnership(jobId, userId)

  switch (payload.action) {
    case 'confirm':
      return confirmFact(jobId, userId, payload.candidateFactId)
    case 'correct':
      return correctFact(jobId, userId, payload.candidateFactId, payload.corrected)
    case 'reject':
      return rejectFact(jobId, userId, payload.candidateFactId, payload.reason)
    case 'confirm_section':
      return confirmSection(jobId, userId, payload.sectionKey, payload.candidateFactIds)
    case 'add_missing':
      return addMissing(jobId, userId, payload.memoryType, payload.memory)
  }
}

// GET /api/jobs/:jobId/memory
export async function listMemory(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const items = await prisma.memoryItem.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  })

  return items.map(formatMemoryItem)
}
