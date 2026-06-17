import { prisma } from '../db/client.js'
import type { CandidateFactDraft, ExtractionProvider } from './types.js'
import { applyPilotCorrectionGuard } from './pilot-correction-guard.js'

function toDbFactType(ft: string): string {
  return ft.toUpperCase()
}

function toDbConfidence(cl: string): string {
  return cl.toUpperCase()
}

// Only strings that are purely numeric (no units, no approximations, no partial text).
const STRICT_DECIMAL_RE = /^\d+(\.\d+)?$/

function strictParsePositive(s: string | null | undefined): number | null {
  if (!s || !STRICT_DECIMAL_RE.test(s)) return null
  const n = parseFloat(s)
  return n > 0 ? n : null
}

// Derive totalCostAmount only when qualifier is "each" and both quantity and
// costAmount are unambiguous numerics. Returns undefined (not null) to leave
// the field unchanged when derivation is not safe.
function deriveSafeTotalCost(fact: CandidateFactDraft): string | undefined {
  if (fact.totalCostAmount) return fact.totalCostAmount
  if (fact.costQualifier !== 'each') return undefined
  const qty = strictParsePositive(fact.quantity)
  const cost = strictParsePositive(fact.costAmount)
  if (qty === null || cost === null) return undefined
  const total = Math.round(qty * cost * 100) / 100
  return String(total)
}

// When the provider supplies an explicit totalCostAmount that disagrees with
// quantity × costAmount (both strict numerics, qualifier "each"), the conflict
// is unresolvable without the pilot's input — mark the fact as cost_uncertain.
function detectCostConflict(fact: CandidateFactDraft): boolean {
  if (fact.costQualifier !== 'each') return false
  if (!fact.totalCostAmount) return false
  const qty = strictParsePositive(fact.quantity)
  const cost = strictParsePositive(fact.costAmount)
  const total = strictParsePositive(fact.totalCostAmount)
  if (qty === null || cost === null || total === null) return false
  const derived = Math.round(qty * cost * 100) / 100
  return Math.abs(derived - total) > 0.001
}

function resolveUncertaintyFlags(fact: CandidateFactDraft): string[] {
  const flags = fact.uncertaintyFlags ?? []
  if (detectCostConflict(fact) && !flags.includes('cost_uncertain')) {
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
