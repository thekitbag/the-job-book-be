import type { Prisma } from '@prisma/client'
import { prisma } from '../db/client.js'
import {
  latestTranscriptOrder,
  staleBefore,
  transcriptionNeedsWork,
} from '../lib/worker-recovery.js'
import type { AudioStorageProvider } from '../storage/index.js'
import { runExtraction } from '../extraction/worker.js'
import type { ExtractionProvider } from '../extraction/index.js'
import type { TranscriptionProvider } from './types.js'

export async function runTranscription(
  noteId: string,
  provider: TranscriptionProvider,
  storage: AudioStorageProvider,
  extractionProvider?: ExtractionProvider,
): Promise<void> {
  const claim = await prisma.$transaction(async (tx) => {
    // Serialize the missing-transcript case across the upload worker and
    // simultaneous server starts. Re-check eligibility under this lock.
    await tx.$queryRaw`SELECT id FROM "raw_notes" WHERE id = ${noteId} FOR UPDATE`
    const note = await tx.rawNote.findUnique({
      where: { id: noteId },
      include: { audioObject: true },
    })
    if (!note?.audioObject) return null
    const latest = await tx.transcript.findFirst({
      where: { noteId },
      orderBy: [...latestTranscriptOrder],
    })
    const startedAt = new Date()
    if (!transcriptionNeedsWork(latest, staleBefore(startedAt))) return null
    const data = {
      status: 'TRANSCRIBING' as const,
      provider: provider.name,
      model: provider.model,
      startedAt,
    }
    const transcript = latest
      ? await tx.transcript.update({
          where: { id: latest.id },
          data: { ...data, retryCount: { increment: 1 } },
        })
      : await tx.transcript.create({ data: { ...data, noteId } })
    await tx.rawNote.update({
      where: { id: noteId },
      data: { serverStatus: 'TRANSCRIBING' },
    })
    return {
      transcriptId: transcript.id,
      startedAt,
      audioObject: note.audioObject,
      mimeType: note.mimeType,
    }
  })
  if (!claim) return

  const { transcriptId, startedAt, audioObject, mimeType } = claim
  let outcome: Prisma.TranscriptUpdateInput
  try {
    const audioBuffer = await storage.read(audioObject.storageKey)
    const result = await provider.transcribe({
      noteId,
      audioKey: audioObject.storageKey,
      audioBuffer,
      mimeType,
    })
    outcome = {
      status: 'COMPLETED',
      text: result.text,
      language: result.language ?? null,
      confidence: result.confidence ?? null,
      providerResponseId: result.providerResponseId ?? null,
    }
  } catch (error) {
    outcome = {
      status: 'FAILED',
      errorCode: (error as { code?: string })?.code ?? 'UNKNOWN',
      errorMessage: (error as { message?: string })?.message ?? String(error),
    }
  }

  // A provider response from an expired claim can never overwrite a recovery.
  const completed = outcome.status === 'COMPLETED'
  const published = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "raw_notes" WHERE id = ${noteId} FOR UPDATE`
    const update = await tx.transcript.updateMany({
      where: { id: transcriptId, status: 'TRANSCRIBING', startedAt },
      data: { ...outcome, completedAt: new Date() },
    })
    if (!update.count) return false
    await tx.rawNote.update({
      where: { id: noteId },
      data: { serverStatus: completed ? 'TRANSCRIBED' : 'FAILED' },
    })
    return true
  })
  if (published && completed && extractionProvider) {
    await runExtraction(transcriptId, extractionProvider)
  }
}
