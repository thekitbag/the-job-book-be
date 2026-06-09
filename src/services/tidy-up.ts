import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

// ── Section mapping (shared with review service) ─────────────────────────────

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

type FactForGrouping = {
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
  uncertaintyFlags: string[]
  sourceNoteId: string
  sourceTranscriptId: string
  sourceNote: { id: string; capturedAt: Date }
  transcript: { id: string; text: string | null }
}

// ── Grouping logic ────────────────────────────────────────────────────────────

function extractProposedMemory(f: FactForGrouping): ProposedMemory {
  return {
    memoryType: f.factType.toLowerCase(),
    summary: f.summary,
    materialName: f.materialName,
    quantity: f.quantity,
    unit: f.unit,
    supplierName: f.supplierName,
    deliveryTiming: f.deliveryTiming,
    locationOrUse: f.locationOrUse,
  }
}

function mostCompleteFact(facts: FactForGrouping[]): FactForGrouping {
  const score = (f: FactForGrouping) =>
    [f.materialName, f.quantity, f.unit, f.supplierName, f.deliveryTiming, f.locationOrUse].filter(
      (v) => v != null,
    ).length
  return facts.reduce((best, f) => (score(f) >= score(best) ? f : best))
}

function unionFlags(facts: FactForGrouping[]): string[] {
  return [...new Set(facts.flatMap((f) => f.uncertaintyFlags))]
}

function deriveConfidence(facts: FactForGrouping[]): string {
  const labels = facts.map((f) => f.confidenceLabel)
  if (labels.includes('LOW')) return 'low'
  if (labels.every((l) => l === 'HIGH')) return 'high'
  return 'medium'
}

function groupFactsForSection(facts: FactForGrouping[], sectionKey: string): GroupedItemData[] {
  const items: GroupedItemData[] = []

  // UNCLEAR facts always become unclear_prompt items (not grouped with others)
  const unclearFacts = facts.filter((f) => f.factType === 'UNCLEAR' || f.status === 'UNCLEAR')
  const typedFacts = facts.filter((f) => f.factType !== 'UNCLEAR' && f.status !== 'UNCLEAR')

  // Group typed facts by normalised materialName
  const byName = new Map<string, FactForGrouping[]>()
  const unnamed: FactForGrouping[] = []

  for (const f of typedFacts) {
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
      // Contradiction: same name, both have non-null quantities that differ
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

  // Unnamed typed facts → single items
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

  // Unclear facts → unclear_prompt items
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

// ── Response formatting ───────────────────────────────────────────────────────

type StoredTidyUpItem = {
  id: string
  sectionKey: string
  kind: string
  status: string
  reviewLabel: string
  summary: string
  proposedMemory: unknown
  confidenceLabel: string
  uncertaintyFlags: string[]
  sourceCandidateFactIds: string[]
}

type StoredTidyUpRun = {
  id: string
  jobId: string
  localDate: string
  status: string
  createdAt: Date
  items: StoredTidyUpItem[]
}

interface SourceContextEntry {
  candidateFactId: string
  noteId: string
  transcriptId: string
  capturedAt: Date
  transcriptText: string | null
}

async function buildSourceContextMap(
  factIds: string[],
): Promise<Map<string, SourceContextEntry>> {
  if (factIds.length === 0) return new Map()

  const facts = await prisma.candidateFact.findMany({
    where: { id: { in: factIds } },
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
  })

  const map = new Map<string, SourceContextEntry>()
  for (const f of facts) {
    map.set(f.id, {
      candidateFactId: f.id,
      noteId: f.sourceNoteId,
      transcriptId: f.sourceTranscriptId,
      capturedAt: f.sourceNote.capturedAt,
      transcriptText: f.transcript.text ?? null,
    })
  }
  return map
}

function buildSourceContextMapFromFacts(
  facts: FactForGrouping[],
): Map<string, SourceContextEntry> {
  const map = new Map<string, SourceContextEntry>()
  for (const f of facts) {
    map.set(f.id, {
      candidateFactId: f.id,
      noteId: f.sourceNoteId,
      transcriptId: f.sourceTranscriptId,
      capturedAt: f.sourceNote.capturedAt,
      transcriptText: f.transcript.text ?? null,
    })
  }
  return map
}

function formatTidyUpRun(
  run: StoredTidyUpRun,
  contextMap: Map<string, SourceContextEntry>,
  alreadyRemembered: Array<{ id: string; summary: string; memoryType: string }>,
) {
  const bySection: Record<string, StoredTidyUpItem[]> = {}
  for (const key of SECTION_KEYS) bySection[key] = []

  for (const item of run.items) {
    const key = SECTION_KEYS.includes(item.sectionKey) ? item.sectionKey : 'unclear_items'
    bySection[key].push(item)
  }

  return {
    id: run.id,
    jobId: run.jobId,
    localDate: run.localDate,
    status: run.status,
    createdAt: run.createdAt,
    sections: SECTION_KEYS.map((key) => ({
      key,
      label: SECTION_LABELS[key],
      items: bySection[key].map((item) => ({
        id: item.id,
        kind: item.kind.toLowerCase(),
        status: item.status.toLowerCase(),
        reviewLabel: item.reviewLabel,
        summary: item.summary,
        proposedMemory: item.proposedMemory,
        confidenceLabel: item.confidenceLabel,
        uncertaintyFlags: item.uncertaintyFlags,
        sourceCandidateFactIds: item.sourceCandidateFactIds,
        sourceContext: item.sourceCandidateFactIds
          .map((id) => contextMap.get(id))
          .filter((c): c is SourceContextEntry => !!c),
      })),
    })),
    alreadyRemembered: alreadyRemembered.map((m) => ({
      memoryItemId: m.id,
      summary: m.summary,
      memoryType: m.memoryType.toLowerCase(),
    })),
  }
}

// ── Ownership helper ──────────────────────────────────────────────────────────

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

// ── Day boundary helpers ──────────────────────────────────────────────────────

function dayBounds(localDate: string) {
  return {
    startOfDay: new Date(`${localDate}T00:00:00.000Z`),
    endOfDay: new Date(`${localDate}T23:59:59.999Z`),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// POST /api/jobs/:jobId/tidy-ups
export async function createOrGetTidyUp(
  jobId: string,
  userId: string,
  localDate: string,
  forceRefresh: boolean,
) {
  await verifyJobOwnership(jobId, userId)

  const { startOfDay, endOfDay } = dayBounds(localDate)

  // Return existing run when not force-refreshing
  if (!forceRefresh) {
    const existing = await prisma.tidyUpRun.findFirst({
      where: { jobId, localDate, status: 'ready' },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    })
    if (existing) {
      const allFactIds = existing.items.flatMap((i) => i.sourceCandidateFactIds)
      const contextMap = await buildSourceContextMap(allFactIds)
      const alreadyRemembered = await loadAlreadyRemembered(jobId, startOfDay, endOfDay)
      return formatTidyUpRun(existing, contextMap, alreadyRemembered)
    }
  }

  // Collect DRAFT/UNCLEAR facts for this job+day (via note capturedAt)
  const facts = await prisma.candidateFact.findMany({
    where: {
      jobId,
      status: { in: ['DRAFT', 'UNCLEAR'] },
      sourceNote: { capturedAt: { gte: startOfDay, lte: endOfDay } },
    },
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Group facts by section
  const factsBySection: Record<string, FactForGrouping[]> = {}
  for (const key of SECTION_KEYS) factsBySection[key] = []

  for (const f of facts) {
    const sectionKey = FACT_TYPE_TO_SECTION[f.factType] ?? 'unclear_items'
    factsBySection[sectionKey].push(f as FactForGrouping)
  }

  const allGroupedItems: GroupedItemData[] = []
  for (const key of SECTION_KEYS) {
    allGroupedItems.push(...groupFactsForSection(factsBySection[key], key))
  }

  // Persist run + items in a transaction
  const { run, items } = await prisma.$transaction(async (tx) => {
    const run = await tx.tidyUpRun.create({
      data: { jobId, localDate, status: 'ready' },
    })

    const items = await (tx.tidyUpItem as typeof prisma.tidyUpItem).createManyAndReturn({
      data: allGroupedItems.map((item) => ({
        tidyUpRunId: run.id,
        jobId,
        sectionKey: item.sectionKey,
        kind: item.kind,
        reviewLabel: item.reviewLabel,
        summary: item.summary,
        proposedMemory: item.proposedMemory as object,
        confidenceLabel: item.confidenceLabel,
        uncertaintyFlags: item.uncertaintyFlags,
        sourceCandidateFactIds: item.sourceCandidateFactIds,
      })),
    })

    return { run, items }
  })

  const contextMap = buildSourceContextMapFromFacts(facts as FactForGrouping[])
  const alreadyRemembered = await loadAlreadyRemembered(jobId, startOfDay, endOfDay)

  return formatTidyUpRun({ ...run, items }, contextMap, alreadyRemembered)
}

// GET /api/jobs/:jobId/tidy-ups/:tidyUpId
export async function getTidyUpById(jobId: string, userId: string, tidyUpId: string) {
  await verifyJobOwnership(jobId, userId)

  const run = await prisma.tidyUpRun.findFirst({
    where: { id: tidyUpId, jobId },
    include: { items: true },
  })

  if (!run) throw { code: ErrorCode.TIDY_UP_NOT_FOUND, message: 'Tidy-up run not found' }

  const { startOfDay, endOfDay } = dayBounds(run.localDate)
  const allFactIds = run.items.flatMap((i) => i.sourceCandidateFactIds)
  const contextMap = await buildSourceContextMap(allFactIds)
  const alreadyRemembered = await loadAlreadyRemembered(jobId, startOfDay, endOfDay)

  return formatTidyUpRun(run, contextMap, alreadyRemembered)
}

// GET /api/jobs/:jobId/tidy-ups?localDate=
export async function getTidyUpByDate(jobId: string, userId: string, localDate: string) {
  await verifyJobOwnership(jobId, userId)

  const run = await prisma.tidyUpRun.findFirst({
    where: { jobId, localDate },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
  })

  if (!run) throw { code: ErrorCode.TIDY_UP_NOT_FOUND, message: 'No tidy-up found for that date' }

  const { startOfDay, endOfDay } = dayBounds(localDate)
  const allFactIds = run.items.flatMap((i) => i.sourceCandidateFactIds)
  const contextMap = await buildSourceContextMap(allFactIds)
  const alreadyRemembered = await loadAlreadyRemembered(jobId, startOfDay, endOfDay)

  return formatTidyUpRun(run, contextMap, alreadyRemembered)
}

// POST /api/jobs/:jobId/tidy-up-decisions
export interface TidyUpDecisionPayload {
  tidyUpItemId: string
  action: 'confirm' | 'correct' | 'reject' | 'leave_unconfirmed'
  corrected?: {
    memoryType?: string
    summary: string
    materialName?: string | null
    quantity?: string | null
    unit?: string | null
    supplierName?: string | null
    deliveryTiming?: string | null
    locationOrUse?: string | null
  }
  reason?: string
}

export async function submitTidyUpDecision(
  jobId: string,
  userId: string,
  payload: TidyUpDecisionPayload,
) {
  await verifyJobOwnership(jobId, userId)

  const item = await prisma.tidyUpItem.findFirst({
    where: { id: payload.tidyUpItemId, jobId },
  })

  if (!item) throw { code: ErrorCode.TIDY_UP_ITEM_NOT_FOUND, message: 'Tidy-up item not found' }

  if (item.status !== 'DRAFT') {
    throw {
      code: ErrorCode.TIDY_UP_ITEM_ALREADY_DECIDED,
      message: `Item has already been decided (status: ${item.status.toLowerCase()})`,
    }
  }

  if (payload.action === 'confirm' && item.kind === 'CONTRADICTION') {
    throw {
      code: ErrorCode.CONTRADICTION_CONFIRM_NOT_ALLOWED,
      message: 'Contradictions must be corrected or rejected, not confirmed as-is',
    }
  }

  const pm = item.proposedMemory as unknown as ProposedMemory
  const sourceCandidateFactIds = item.sourceCandidateFactIds

  if (payload.action === 'confirm') {
    const result = await prisma.$transaction(async (tx) => {
      await tx.tidyUpItem.update({ where: { id: item.id }, data: { status: 'CONFIRMED' } })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          tidyUpDecisionId: null, // filled below after decision created
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
        },
      })

      const decision = await tx.tidyUpDecision.create({
        data: {
          tidyUpItemId: item.id,
          jobId,
          decidedBy: userId,
          action: 'CONFIRM',
          memoryItemId: memoryItem.id,
          sourceCandidateFactIds,
        },
      })

      // Back-fill tidyUpDecisionId on the memory item
      await tx.memoryItem.update({
        where: { id: memoryItem.id },
        data: { tidyUpDecisionId: decision.id },
      })

      await tx.candidateFact.updateMany({
        where: { id: { in: sourceCandidateFactIds } },
        data: { status: 'CONFIRMED' },
      })

      return { decision, memoryItem }
    })

    return {
      tidyUpItemId: item.id,
      action: 'confirm',
      status: 'confirmed',
      memoryItemId: result.memoryItem.id,
      sourceCandidateFactIds,
    }
  }

  if (payload.action === 'correct') {
    const corrected = payload.corrected!
    const memoryType = ((corrected.memoryType ?? pm.memoryType).toUpperCase()) as never

    const result = await prisma.$transaction(async (tx) => {
      await tx.tidyUpItem.update({ where: { id: item.id }, data: { status: 'CORRECTED' } })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          tidyUpDecisionId: null,
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
        },
      })

      const decision = await tx.tidyUpDecision.create({
        data: {
          tidyUpItemId: item.id,
          jobId,
          decidedBy: userId,
          action: 'CORRECT',
          correctedFields: corrected as object,
          memoryItemId: memoryItem.id,
          sourceCandidateFactIds,
        },
      })

      await tx.memoryItem.update({
        where: { id: memoryItem.id },
        data: { tidyUpDecisionId: decision.id },
      })

      await tx.candidateFact.updateMany({
        where: { id: { in: sourceCandidateFactIds } },
        data: { status: 'CORRECTED' },
      })

      return { decision, memoryItem }
    })

    return {
      tidyUpItemId: item.id,
      action: 'correct',
      status: 'corrected',
      memoryItemId: result.memoryItem.id,
      sourceCandidateFactIds,
    }
  }

  if (payload.action === 'reject') {
    await prisma.$transaction(async (tx) => {
      await tx.tidyUpItem.update({ where: { id: item.id }, data: { status: 'REJECTED' } })
      await tx.tidyUpDecision.create({
        data: {
          tidyUpItemId: item.id,
          jobId,
          decidedBy: userId,
          action: 'REJECT',
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
      tidyUpItemId: item.id,
      action: 'reject',
      status: 'rejected',
      memoryItemId: null,
      sourceCandidateFactIds,
    }
  }

  // leave_unconfirmed: no memory, no candidate fact status change
  await prisma.$transaction(async (tx) => {
    await tx.tidyUpItem.update({ where: { id: item.id }, data: { status: 'LEFT_UNCONFIRMED' } })
    await tx.tidyUpDecision.create({
      data: {
        tidyUpItemId: item.id,
        jobId,
        decidedBy: userId,
        action: 'LEAVE_UNCONFIRMED',
        sourceCandidateFactIds,
      },
    })
    // Source candidate facts remain DRAFT/UNCLEAR — not resolved
  })

  return {
    tidyUpItemId: item.id,
    action: 'leave_unconfirmed',
    status: 'left_unconfirmed',
    memoryItemId: null,
    sourceCandidateFactIds,
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function loadAlreadyRemembered(jobId: string, startOfDay: Date, endOfDay: Date) {
  // Memory items for this day's candidate facts (approximated by createdAt UTC date)
  return prisma.memoryItem.findMany({
    where: { jobId, createdAt: { gte: startOfDay, lte: endOfDay } },
    select: { id: true, summary: true, memoryType: true },
  })
}
