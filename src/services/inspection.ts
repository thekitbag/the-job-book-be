import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { buildFreshQueueSections } from './review-queue.js'

// ── Status normalisers ────────────────────────────────────────────────────────

const TRANSCRIPT_STATUS_MAP: Record<string, string> = {
  PENDING: 'waiting',
  TRANSCRIBING: 'transcribing',
  COMPLETED: 'ready',
  FAILED: 'failed',
}

const EXTRACTION_STATUS_MAP: Record<string, string> = {
  PENDING: 'waiting',
  EXTRACTING: 'extracting',
  COMPLETED: 'ready',
  FAILED: 'failed',
}

const DECISION_ACTION_MAP: Record<string, string> = {
  CONFIRM: 'confirm',
  CORRECT: 'correct',
  REJECT: 'reject',
  CONFIRM_SECTION: 'confirm_section',
  ADD_MISSING: 'add_missing',
  QUEUE_CONFIRM: 'queue_confirm',
  QUEUE_CORRECT: 'queue_correct',
  QUEUE_DISMISS: 'queue_dismiss',
}

// ── Possible-miss heuristic ───────────────────────────────────────────────────

const POSSIBLE_MISS_PATTERN =
  /\b(order(?:ed)?|material|deliver(?:y|ed)?|supplier|bought|purchase(?:d)?|plasterboard|timber|brick|concrete|cement|sheet|beam|bolt|screw|nail|insulation|frame|joist|rafter|truss)\b/i

// ── UK local date (Europe/London, handles BST/GMT automatically) ──────────────
// en-CA produces YYYY-MM-DD; combined with the timezone this gives the pilot's local date.

function toUKDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date)
}

// ── Review state for a candidate fact ─────────────────────────────────────────

function reviewState(status: string, hasDecisions: boolean): string {
  if (status === 'CONFIRMED') return 'confirmed'
  if (status === 'CORRECTED') return 'edited'
  if (status === 'REJECTED') return 'dismissed'
  if (status === 'SUPERSEDED') return 'superseded'
  if (status === 'DRAFT' || status === 'UNCLEAR') return 'waiting'
  return hasDecisions ? status.toLowerCase() : 'waiting'
}

// ── Main inspection assembler ─────────────────────────────────────────────────

export async function getJobInspection(jobId: string, userId: string) {
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

  const [notes, decisions, memoryItems] = await Promise.all([
    prisma.rawNote.findMany({
      where: { jobId },
      include: {
        audioObject: { select: { id: true } },
        transcripts: { orderBy: { revision: 'desc' } },
        candidateFacts: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { capturedAt: 'desc' },
    }),
    prisma.reviewDecision.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.memoryItem.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  // Generate a fresh queue from current unresolved facts (same generation path
  // as the review-queue route — ensures inspection always reflects current state).
  const { sections: queueSections } = await buildFreshQueueSections(jobId, new Date())

  // Build fact → decision IDs map (via candidateFactId and sourceCandidateFactIds)
  const decisionsByFactId = new Map<string, string[]>()
  for (const d of decisions) {
    if (d.candidateFactId) {
      const existing = decisionsByFactId.get(d.candidateFactId) ?? []
      existing.push(d.id)
      decisionsByFactId.set(d.candidateFactId, existing)
    }
    for (const fid of d.sourceCandidateFactIds) {
      const existing = decisionsByFactId.get(fid) ?? []
      if (!existing.includes(d.id)) existing.push(d.id)
      decisionsByFactId.set(fid, existing)
    }
  }

  // Build fact → memory item IDs map.
  // Primary: MemoryItem.sourceCandidateFactId.
  // Secondary: all facts in the linked review decision's sourceCandidateFactIds
  // — captures secondary sources in duplicate/contradiction groups.
  const decisionsById = new Map(decisions.map((d) => [d.id, d]))
  const memoryByFactId = new Map<string, string[]>()
  for (const m of memoryItems) {
    if (m.sourceCandidateFactId) {
      const existing = memoryByFactId.get(m.sourceCandidateFactId) ?? []
      existing.push(m.id)
      memoryByFactId.set(m.sourceCandidateFactId, existing)
    }
    const dec = decisionsById.get(m.reviewDecisionId)
    if (dec) {
      for (const fid of dec.sourceCandidateFactIds) {
        if (fid === m.sourceCandidateFactId) continue
        const existing = memoryByFactId.get(fid) ?? []
        if (!existing.includes(m.id)) existing.push(m.id)
        memoryByFactId.set(fid, existing)
      }
    }
  }

  // Group notes by UK local date of capturedAt, days newest first
  const dayMap = new Map<string, typeof notes>()
  for (const note of notes) {
    const day = toUKDate(note.capturedAt)
    if (!dayMap.has(day)) dayMap.set(day, [])
    dayMap.get(day)!.push(note)
  }

  const notesByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([localDate, dayNotes]) => ({
      localDate,
      notes: dayNotes.map((n) => formatNote(n, decisionsByFactId, memoryByFactId)),
    }))

  const possibleMisses = notes.flatMap((note) => {
    const transcript = note.transcripts[0] ?? null
    if (!transcript || transcript.status !== 'COMPLETED' || !transcript.text) return []
    if (note.candidateFacts.length > 0) return []
    if (!POSSIBLE_MISS_PATTERN.test(transcript.text)) return []
    return [
      {
        noteId: note.id,
        reason: 'Transcript contains material-like wording but no candidate facts were extracted',
        transcriptExcerpt: transcript.text.slice(0, 200),
      },
    ]
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
    notesByDay,
    queue: { sections: queueSections },
    reviewDecisions: decisions.map((d) => ({
      id: d.id,
      action: DECISION_ACTION_MAP[d.action] ?? d.action.toLowerCase(),
      candidateFactId: d.candidateFactId,
      sourceCandidateFactIds: d.sourceCandidateFactIds,
      sectionKey: d.sectionKey,
      reason: d.reason,
      createdAt: d.createdAt,
    })),
    memoryItems: memoryItems.map((m) => ({
      id: m.id,
      memoryType: m.memoryType.toLowerCase(),
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
    })),
    possibleMisses,
  }
}

// ── Note formatter ────────────────────────────────────────────────────────────

function formatNote(
  note: {
    id: string
    clientNoteId: string
    capturedAt: Date
    uploadedAt: Date
    serverStatus: string
    mimeType: string
    durationMs: number | null
    sizeBytes: number
    audioObject: { id: string } | null
    transcripts: Array<{
      id: string
      status: string
      text: string | null
      language: string | null
      provider: string | null
      model: string | null
      errorCode: string | null
      extractionStatus: string | null
      extractionErrorCode: string | null
    }>
    candidateFacts: Array<{
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
      sourceTranscriptId: string
    }>
  },
  decisionsByFactId: Map<string, string[]>,
  memoryByFactId: Map<string, string[]>
) {
  const latestTranscript = note.transcripts[0] ?? null

  return {
    id: note.id,
    clientNoteId: note.clientNoteId,
    capturedAt: note.capturedAt,
    uploadedAt: note.uploadedAt,
    serverStatus: note.serverStatus.toLowerCase(),
    mimeType: note.mimeType,
    durationMs: note.durationMs,
    sizeBytes: note.sizeBytes,
    audioStored: note.audioObject !== null,
    transcript: latestTranscript
      ? {
          id: latestTranscript.id,
          status: TRANSCRIPT_STATUS_MAP[latestTranscript.status] ?? latestTranscript.status.toLowerCase(),
          text: latestTranscript.text,
          language: latestTranscript.language,
          provider: latestTranscript.provider,
          model: latestTranscript.model,
          errorCode: latestTranscript.errorCode,
          extractionStatus:
            latestTranscript.extractionStatus !== null
              ? (EXTRACTION_STATUS_MAP[latestTranscript.extractionStatus] ?? latestTranscript.extractionStatus.toLowerCase())
              : null,
          extractionErrorCode: latestTranscript.extractionErrorCode,
        }
      : null,
    candidateFacts: note.candidateFacts.map((f) => {
      const decisionIds = decisionsByFactId.get(f.id) ?? []
      const memIds = memoryByFactId.get(f.id) ?? []
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
        uncertaintyFlags: f.uncertaintyFlags,
        sourceTranscriptId: f.sourceTranscriptId,
        reviewState: reviewState(f.status, decisionIds.length > 0),
        reviewDecisionIds: decisionIds,
        memoryItemIds: memIds,
      }
    }),
  }
}
