import type { RawNote, CaptureContext } from '@prisma/client'
import {
  captureError,
  lockNote,
  requireFileableJob,
} from './capture-ownership.js'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../db/client.js'
import type { AudioStorageProvider } from '../storage/index.js'
import { ErrorCode } from '../types/errors.js'

const SUPPORTED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/webm; codecs=opus',
])

// 25 MB — below OpenAI's 26 MB transcription limit
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function isSupportedMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase().trim())
}

export function normaliseMimeType(raw: string): string {
  // Preserve exact submitted value but normalise whitespace around semicolon
  return raw.trim().replace(/\s*;\s*/g, ';')
}

export interface UploadNoteInput {
  jobId: string | null
  captureContext?: CaptureContext
  legacy?: boolean
  userId: string
  clientNoteId: string
  capturedAt: Date
  durationMs?: number
  mimeType: string
  audioBuffer: Buffer
}

export const captureNote = (note: RawNote) => ({
  id: note.id,
  clientNoteId: note.clientNoteId,
  jobId: note.jobId,
  filedAt: note.filedAt,
  captureContext: note.captureContext.toLowerCase(),
  serverStatus: note.serverStatus,
})

export async function fileNote(
  noteId: string,
  userId: string,
  jobId: string,
  fromRetry = false,
) {
  return prisma.$transaction(async (tx) => {
    const note = await lockNote(tx, noteId, userId)
    await requireFileableJob(tx, jobId, userId)
    if (note.jobId === jobId || (fromRetry && note.jobId)) return note
    if (note.jobId)
      throw captureError(
        'NOTE_ALREADY_FILED',
        'This note is already filed. Use move to change the job.',
      )
    return tx.rawNote.update({
      where: { id: noteId },
      data: { jobId, filedAt: new Date() },
    })
  })
}

export async function uploadNote(
  input: UploadNoteInput,
  storage: AudioStorageProvider,
) {
  const {
    jobId,
    userId,
    clientNoteId,
    capturedAt,
    durationMs,
    mimeType,
    audioBuffer,
  } = input
  if (!isSupportedMimeType(mimeType)) {
    throw {
      code: ErrorCode.AUDIO_UNSUPPORTED_TYPE,
      message: `MIME type not supported: ${mimeType}`,
    }
  }
  if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw {
      code: ErrorCode.AUDIO_TOO_LARGE,
      message: `Audio exceeds max size of ${MAX_AUDIO_BYTES} bytes`,
    }
  }
  if (
    !Number.isFinite(capturedAt.getTime()) ||
    (durationMs != null &&
      (!Number.isInteger(durationMs) ||
        durationMs < 0 ||
        durationMs > 2147483647))
  ) {
    throw captureError('INVALID_FIELD', 'capturedAt or durationMs is invalid')
  }
  if (jobId) {
    if (input.legacy) {
      const job = await prisma.job.findUnique({ where: { id: jobId } })
      if (!job) throw captureError('JOB_NOT_FOUND', 'Job not found')
      if (job.ownerUserId !== userId)
        throw captureError('FORBIDDEN', 'Access denied')
    } else await requireFileableJob(prisma, jobId, userId)
  }
  const where = {
    ownerUserId_clientNoteId: { ownerUserId: userId, clientNoteId },
  }
  const duplicate = async (note: RawNote) => ({
    note:
      jobId && !note.jobId
        ? await fileNote(note.id, userId, jobId, true)
        : note,
    isDuplicate: true,
  })
  const existing = await prisma.rawNote.findUnique({
    where,
    include: { audioObject: true },
  })
  if (existing) return duplicate(existing)

  const id = uuidv4()
  const storedMimeType = normaliseMimeType(mimeType)
  const storageKey = `notes/${jobId ?? userId}/${id}.webm`
  const stored = await storage.store(storageKey, audioBuffer, storedMimeType)
  try {
    const note = await prisma.$transaction(async (tx) => {
      const row = await tx.rawNote.create({
        data: {
          id,
          jobId,
          ownerUserId: userId,
          clientNoteId,
          capturedAt,
          durationMs,
          captureContext: input.captureContext ?? 'JOB',
          filedAt: jobId ? new Date() : null,
          mimeType: storedMimeType,
          sizeBytes: stored.sizeBytes,
          serverStatus: 'UPLOADED',
        },
      })
      await tx.audioObject.create({
        data: {
          noteId: id,
          storageKey: stored.key,
          bucket: stored.bucket,
          mimeType: storedMimeType,
          sizeBytes: stored.sizeBytes,
        },
      })
      return row
    })
    return { note, isDuplicate: false }
  } catch (err) {
    await storage.delete(stored.key).catch(() => {})
    if (isUniqueConstraintViolation(err)) {
      const winner = await prisma.rawNote.findUnique({ where })
      if (winner) return duplicate(winner)
    }
    throw err
  }
}

type TranscriptRow = {
  status: string
  text?: string | null
  language?: string | null
  provider?: string | null
  model?: string | null
  errorCode?: string | null
  completedAt?: Date | null
  extractionStatus?: string | null
}

function mapTranscriptStatus(
  t: TranscriptRow | undefined,
): 'waiting' | 'transcribing' | 'ready' | 'failed' {
  if (!t) return 'waiting'
  if (t.status === 'TRANSCRIBING') return 'transcribing'
  if (t.status === 'COMPLETED') return 'ready'
  if (t.status === 'FAILED') return 'failed'
  return 'waiting'
}

function mapExtractionStatus(
  t: TranscriptRow | undefined,
): 'waiting' | 'extracting' | 'ready' | 'failed' {
  if (!t || !t.extractionStatus) return 'waiting'
  if (t.extractionStatus === 'EXTRACTING') return 'extracting'
  if (t.extractionStatus === 'COMPLETED') return 'ready'
  if (t.extractionStatus === 'FAILED') return 'failed'
  return 'waiting'
}

// Inline summary used on list/detail responses — status only, no text
function transcriptSummary(t: TranscriptRow | undefined) {
  return {
    status: mapTranscriptStatus(t),
    extractionStatus: mapExtractionStatus(t),
  }
}

export async function listNotes(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId)
    throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const notes = await prisma.rawNote.findMany({
    where: { jobId },
    include: {
      transcripts: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { capturedAt: 'asc' },
  })

  return notes.map((n) => ({
    id: n.id,
    clientNoteId: n.clientNoteId,
    capturedAt: n.capturedAt,
    uploadedAt: n.uploadedAt,
    mimeType: n.mimeType,
    durationMs: n.durationMs,
    sizeBytes: n.sizeBytes,
    serverStatus: n.serverStatus,
    transcript: transcriptSummary(n.transcripts?.[0]),
  }))
}

export async function getNote(jobId: string, noteId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId)
    throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const note = await prisma.rawNote.findFirst({
    where: { id: noteId, jobId },
    include: {
      transcripts: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  if (!note) throw { code: ErrorCode.NOTE_NOT_FOUND, message: 'Note not found' }

  return {
    id: note.id,
    clientNoteId: note.clientNoteId,
    capturedAt: note.capturedAt,
    uploadedAt: note.uploadedAt,
    mimeType: note.mimeType,
    durationMs: note.durationMs,
    sizeBytes: note.sizeBytes,
    serverStatus: note.serverStatus,
    transcript: transcriptSummary(note.transcripts?.[0]),
  }
}

export async function getTranscript(
  jobId: string,
  noteId: string,
  userId: string,
) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId)
    throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const note = await prisma.rawNote.findFirst({
    where: { id: noteId, jobId },
    include: {
      transcripts: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  if (!note) throw { code: ErrorCode.NOTE_NOT_FOUND, message: 'Note not found' }

  const t = note.transcripts?.[0]
  const status = mapTranscriptStatus(t)

  if (!t || status === 'waiting') {
    return { noteId, status: 'waiting' as const }
  }

  if (status === 'transcribing') {
    return { noteId, status: 'transcribing' as const }
  }

  if (status === 'failed') {
    return {
      noteId,
      status: 'failed' as const,
      errorCode: t.errorCode ?? 'UNKNOWN',
    }
  }

  return {
    noteId,
    status: 'ready' as const,
    text: t.text ?? '',
    language: t.language ?? null,
    provider: t.provider ?? null,
    model: t.model ?? null,
    completedAt: t.completedAt ?? null,
    extractionStatus: mapExtractionStatus(t),
  }
}

export function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  )
}

export { MAX_AUDIO_BYTES, SUPPORTED_MIME_TYPES }
