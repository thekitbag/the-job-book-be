import { prisma } from '../db/client.js'
import type { ExtractionProvider } from './types.js'
import { applyPilotCorrectionGuard } from './pilot-correction-guard.js'

function toDbFactType(ft: string): string {
  return ft.toUpperCase()
}

function toDbConfidence(cl: string): string {
  return cl.toUpperCase()
}

export async function runExtraction(
  transcriptId: string,
  provider: ExtractionProvider,
): Promise<void> {
  const transcript = await prisma.transcript.findUnique({
    where: { id: transcriptId },
    include: { note: { include: { job: true } } },
  })

  // Only extract from completed transcripts with text; skip if already done or in-flight
  if (!transcript || transcript.status !== 'COMPLETED' || !transcript.text) return
  if (transcript.extractionStatus === 'COMPLETED' || transcript.extractionStatus === 'EXTRACTING') return

  await prisma.transcript.update({
    where: { id: transcriptId },
    data: { extractionStatus: 'EXTRACTING', extractionStartedAt: new Date() },
  })

  await prisma.rawNote.update({
    where: { id: transcript.noteId },
    data: { serverStatus: 'EXTRACTING' },
  })

  let succeeded = false

  try {
    const result = await provider.extractFacts({
      transcriptId,
      noteId: transcript.noteId,
      jobId: transcript.note.jobId,
      transcriptText: transcript.text,
      jobContext: {
        title: transcript.note.job.title,
        jobType: transcript.note.job.jobType,
      },
    })

    const guardedFacts = applyPilotCorrectionGuard({
      transcriptText: transcript.text,
      jobContext: {
        title: transcript.note.job.title,
        jobType: transcript.note.job.jobType,
      },
      facts: result.facts,
    })

    await prisma.$transaction(async (tx) => {
      // Delete any facts from a prior partial run before re-creating them atomically
      await tx.candidateFact.deleteMany({ where: { sourceTranscriptId: transcriptId } })

      for (const fact of guardedFacts) {
        const isUnclear = fact.factType === 'unclear'
        await tx.candidateFact.create({
          data: {
            jobId: transcript.note.jobId,
            sourceNoteId: transcript.noteId,
            sourceTranscriptId: transcriptId,
            factType: toDbFactType(fact.factType) as never,
            status: isUnclear ? 'UNCLEAR' : 'DRAFT',
            summary: fact.summary,
            materialName: fact.materialName ?? null,
            quantity: fact.quantity ?? null,
            unit: fact.unit ?? null,
            supplierName: fact.supplierName ?? null,
            deliveryTiming: fact.deliveryTiming ?? null,
            locationOrUse: fact.locationOrUse ?? null,
            confidenceLabel: toDbConfidence(fact.confidenceLabel) as never,
            confidenceReason: fact.confidenceReason,
            uncertaintyFlags: fact.uncertaintyFlags,
            extractionProvider: provider.name,
            extractionModel: provider.model,
            extractionSchemaVersion: result.schemaVersion,
          },
        })
      }

      await tx.transcript.update({
        where: { id: transcriptId },
        data: {
          extractionStatus: 'COMPLETED',
          extractionProvider: provider.name,
          extractionModel: provider.model,
          extractionSchemaVersion: result.schemaVersion,
          extractionCompletedAt: new Date(),
        },
      })
    })

    await prisma.rawNote.update({
      where: { id: transcript.noteId },
      data: { serverStatus: 'EXTRACTED' },
    })

    succeeded = true
  } catch (err: unknown) {
    const errorCode = (err as { code?: string })?.code ?? 'UNKNOWN'
    const errorMessage = (err as { message?: string })?.message ?? String(err)

    // Transcript transcription status is preserved (stays COMPLETED)
    // Only extractionStatus is updated to FAILED
    await prisma.transcript.update({
      where: { id: transcriptId },
      data: {
        extractionStatus: 'FAILED',
        extractionErrorCode: errorCode,
        extractionErrorMessage: errorMessage,
        extractionCompletedAt: new Date(),
      },
    }).catch(() => {})

    // Note returns to TRANSCRIBED, not FAILED, to distinguish from transcription failure
    await prisma.rawNote.update({
      where: { id: transcript.noteId },
      data: { serverStatus: 'TRANSCRIBED' },
    }).catch(() => {})
  }

  void succeeded // extraction result used only for status tracking above
}
