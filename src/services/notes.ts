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
  jobId: string
  userId: string
  clientNoteId: string
  capturedAt: Date
  durationMs?: number
  mimeType: string
  audioBuffer: Buffer
}

export interface UploadNoteResult {
  noteId: string
  clientNoteId: string
  status: string
  isDuplicate: boolean
}

export async function uploadNote(
  input: UploadNoteInput,
  storage: AudioStorageProvider,
): Promise<UploadNoteResult> {
  const { jobId, userId, clientNoteId, capturedAt, durationMs, mimeType, audioBuffer } = input

  if (!isSupportedMimeType(mimeType)) {
    throw { code: ErrorCode.AUDIO_UNSUPPORTED_TYPE, message: `MIME type not supported: ${mimeType}` }
  }

  if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw { code: ErrorCode.AUDIO_TOO_LARGE, message: `Audio exceeds max size of ${MAX_AUDIO_BYTES} bytes` }
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const existing = await prisma.rawNote.findUnique({
    where: { jobId_clientNoteId: { jobId, clientNoteId } },
    include: { audioObject: true },
  })

  if (existing) {
    return {
      noteId: existing.id,
      clientNoteId: existing.clientNoteId,
      status: existing.serverStatus,
      isDuplicate: true,
    }
  }

  const noteId = uuidv4()
  const storedMimeType = normaliseMimeType(mimeType)
  const storageKey = `notes/${jobId}/${noteId}.webm`

  const stored = await storage.store(storageKey, audioBuffer, storedMimeType)

  try {
    await prisma.$transaction(async (tx) => {
      await tx.rawNote.create({
        data: {
          id: noteId,
          jobId,
          clientNoteId,
          capturedAt,
          mimeType: storedMimeType,
          durationMs,
          sizeBytes: stored.sizeBytes,
          serverStatus: 'UPLOADED',
        },
      })

      await tx.audioObject.create({
        data: {
          noteId,
          storageKey: stored.key,
          bucket: stored.bucket,
          mimeType: storedMimeType,
          sizeBytes: stored.sizeBytes,
        },
      })
    })
  } catch (dbErr) {
    if (isUniqueConstraintViolation(dbErr)) {
      // A concurrent request already inserted this clientNoteId.
      // Clean up the orphaned audio file we just wrote and return the winner.
      await storage.delete(storageKey).catch(() => {})
      const winner = await prisma.rawNote.findUnique({
        where: { jobId_clientNoteId: { jobId, clientNoteId } },
      })
      if (winner) {
        return { noteId: winner.id, clientNoteId: winner.clientNoteId, status: winner.serverStatus, isDuplicate: true }
      }
    }
    throw dbErr
  }

  return { noteId, clientNoteId, status: 'UPLOADED', isDuplicate: false }
}

type TranscriptRow = { status: string; text?: string | null; language?: string | null; provider?: string | null; model?: string | null; errorCode?: string | null; completedAt?: Date | null }

function mapTranscriptStatus(t: TranscriptRow | undefined): 'waiting' | 'transcribing' | 'ready' | 'failed' {
  if (!t) return 'waiting'
  if (t.status === 'TRANSCRIBING') return 'transcribing'
  if (t.status === 'COMPLETED') return 'ready'
  if (t.status === 'FAILED') return 'failed'
  return 'waiting'
}

// Inline summary used on list/detail responses — status only, no text
function transcriptSummary(t: TranscriptRow | undefined) {
  return { status: mapTranscriptStatus(t) }
}

export async function listNotes(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

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
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

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

export async function getTranscript(jobId: string, noteId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

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
    return { noteId, status: 'failed' as const, errorCode: t.errorCode ?? 'UNKNOWN' }
  }

  return {
    noteId,
    status: 'ready' as const,
    text: t.text ?? '',
    language: t.language ?? null,
    provider: t.provider ?? null,
    model: t.model ?? null,
    completedAt: t.completedAt ?? null,
  }
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  )
}

export { MAX_AUDIO_BYTES, SUPPORTED_MIME_TYPES }
