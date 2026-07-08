import { prisma } from '../db/client.js'
import type { CandidateFactDraft, ExtractionProvider } from './types.js'
import { applyPilotCorrectionGuard } from './pilot-correction-guard.js'
import { strictParsePositive, deriveSafeMaterialTotal, deriveSafeLabourTotal, hasCostConflict } from '../lib/cost-utils.js'
import { resolveDraftHappenedAt, ukLocalDayString, ukLocalNoon } from '../lib/dates.js'

function toDbFactType(ft: string): string {
  return ft.toUpperCase()
}

function toDbConfidence(cl: string): string {
  return cl.toUpperCase()
}

// Preserve an explicit totalCostAmount from the provider, or derive one when it is
// unambiguous: material "each" (qty × unit cost) or labour "per_hour" (hours × rate).
// Returns undefined (not null) so the field stays unset when derivation is not safe.
function deriveSafeTotalCost(fact: CandidateFactDraft): string | undefined {
  if (fact.totalCostAmount) return fact.totalCostAmount
  const derived =
    deriveSafeMaterialTotal(fact.quantity, fact.unit, fact.costAmount, fact.costCurrency, fact.costQualifier) ??
    deriveSafeLabourTotal(fact.labourHours, fact.costAmount, fact.costQualifier)
  return derived ?? undefined
}

// Effective day for a fact. Labour always gets one: a spoken day resolved
// against the note capture date, else the capture day itself (UK local noon).
// Other fact types only store a day the provider actually resolved.
function resolveHappenedAt(fact: CandidateFactDraft, noteCapturedAt: Date): Date | null {
  const resolved = resolveDraftHappenedAt(fact.happenedAt, noteCapturedAt)
  if (resolved) return resolved
  if (fact.factType === 'labour') return ukLocalNoon(ukLocalDayString(noteCapturedAt))
  return null
}

function resolveUncertaintyFlags(fact: CandidateFactDraft): string[] {
  const flags = fact.uncertaintyFlags ?? []
  if (hasCostConflict(fact.quantity, fact.costAmount, fact.costQualifier, fact.totalCostAmount) &&
      !flags.includes('cost_uncertain')) {
    return [...flags, 'cost_uncertain']
  }
  return flags
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
      noteCapturedAt: transcript.note.capturedAt,
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
            costAmount: fact.costAmount ?? null,
            costCurrency: fact.costCurrency ?? null,
            costQualifier: fact.costQualifier ?? null,
            totalCostAmount: deriveSafeTotalCost(fact) ?? null,
            labourHours: fact.labourHours ?? null,
            labourPerson: fact.labourPerson ?? null,
            labourTask: fact.labourTask ?? null,
            happenedAt: resolveHappenedAt(fact, transcript.note.capturedAt),
            confidenceLabel: toDbConfidence(fact.confidenceLabel) as never,
            confidenceReason: fact.confidenceReason,
            uncertaintyFlags: resolveUncertaintyFlags(fact),
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
