import { latestTranscriptOrder, staleBefore } from '../lib/worker-recovery.js'
import { isMoneyFeaturesEnabled } from '../config/features.js'
import {
  QUEUE_MEMORY_TYPES,
  ignoreMoneyInput,
  stripMoneyPhrase,
} from '../lib/job-memory.js'
import { prisma } from '../db/client.js'
import type { CandidateFactDraft, ExtractionProvider } from './types.js'
import { applyPilotCorrectionGuard } from './pilot-correction-guard.js'
import {
  strictParsePositive,
  deriveSafeMaterialTotal,
  deriveSafeLabourTotal,
  hasCostConflict,
} from '../lib/cost-utils.js'
import {
  resolveDraftHappenedAt,
  ukLocalDayString,
  ukLocalNoon,
} from '../lib/dates.js'
import { apiMemoryTypeDefaultsToRecordedDay } from '../lib/memory-types.js'

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
    deriveSafeMaterialTotal(
      fact.quantity,
      fact.unit,
      fact.costAmount,
      fact.costCurrency,
      fact.costQualifier,
    ) ??
    deriveSafeLabourTotal(fact.labourHours, fact.costAmount, fact.costQualifier)
  return derived ?? undefined
}

// Effective day for a fact: a spoken day resolved against the note capture date
// wins. Failing that, types whose date is read back as evidence — bought/ordered
// material, which can appear as a dated line inside a supplier payment receipt,
// and labour, which rolls up into day totals — fall back to the day the note was
// captured (UK local noon).
//
// That capture day is Mike's own first-hand evidence: he recorded the note on a
// real day, on the site, about what he had just done. It is recorded HERE, once,
// at extraction time — never re-derived when a receipt is rendered, where it
// would be a guess dressed as a fact.
//
// Every other fact type still stores only a day the provider actually resolved.
function resolveHappenedAt(
  fact: CandidateFactDraft,
  noteCapturedAt: Date,
): Date | null {
  const resolved = resolveDraftHappenedAt(fact.happenedAt, noteCapturedAt)
  if (resolved) return resolved
  if (apiMemoryTypeDefaultsToRecordedDay(fact.factType)) {
    return ukLocalNoon(ukLocalDayString(noteCapturedAt))
  }
  return null
}

function resolveUncertaintyFlags(fact: CandidateFactDraft): string[] {
  const flags = fact.uncertaintyFlags ?? []
  if (
    hasCostConflict(
      fact.quantity,
      fact.costAmount,
      fact.costQualifier,
      fact.totalCostAmount,
    ) &&
    !flags.includes('cost_uncertain')
  ) {
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

  if (
    !transcript?.note.jobId ||
    !transcript.note.job ||
    transcript.status !== 'COMPLETED'
  )
    return
  if (
    transcript.extractionStatus === 'COMPLETED' ||
    transcript.extractionStatus === 'FAILED'
  )
    return

  const startedAt = new Date()
  const cutoff = staleBefore(startedAt)
  if (
    transcript.extractionStatus === 'EXTRACTING' &&
    !((transcript.extractionStartedAt ?? transcript.updatedAt) < cutoff)
  )
    return
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "raw_notes" WHERE id = ${transcript.noteId} FOR UPDATE`
    const claim = await tx.transcript.updateMany({
      where: {
        id: transcriptId,
        status: 'COMPLETED',
        OR: [
          { extractionStatus: null },
          { extractionStatus: 'PENDING' },
          {
            extractionStatus: 'EXTRACTING',
            extractionStartedAt: { lt: cutoff },
          },
          {
            extractionStatus: 'EXTRACTING',
            extractionStartedAt: null,
            updatedAt: { lt: cutoff },
          },
        ],
      },
      data: { extractionStatus: 'EXTRACTING', extractionStartedAt: startedAt },
    })
    if (claim.count !== 1) return false
    await tx.rawNote.update({
      where: { id: transcript.noteId },
      data: { serverStatus: 'EXTRACTING' },
    })
    return true
  })
  if (!claimed) return
  const claimWhere = {
    id: transcriptId,
    extractionStatus: 'EXTRACTING' as const,
    extractionStartedAt: startedAt,
  }
  const transcriptText = transcript.text ?? ''

  try {
    const result = transcriptText.trim()
      ? await provider.extractFacts({
          transcriptId,
          noteId: transcript.noteId,
          jobId: transcript.note.jobId,
          transcriptText,
          noteCapturedAt: transcript.note.capturedAt,
          jobContext: {
            title: transcript.note.job.title,
            jobType: transcript.note.job.jobType,
          },
        })
      : null

    const guardedFacts = result
      ? applyPilotCorrectionGuard({
          transcriptText,
          jobContext: {
            title: transcript.note.job.title,
            jobType: transcript.note.job.jobType,
          },
          facts:
            result.schemaVersion === 'v3-job-memory' ||
            !isMoneyFeaturesEnabled()
              ? result.facts
                  .filter(
                    (f) =>
                      QUEUE_MEMORY_TYPES.has(f.factType.toUpperCase()) &&
                      (f.factType !== 'labour' || f.labourHours != null),
                  )
                  .map((f) => ({
                    ...ignoreMoneyInput(f),
                    summary: stripMoneyPhrase(f.summary),
                    labourPerson: /^(me|i|myself)$/i.test(
                      f.labourPerson?.trim() ?? '',
                    )
                      ? null
                      : f.labourPerson,
                  }))
              : result.facts,
        })
      : []

    await prisma.$transaction(async (tx) => {
      // Lock the note when publishing. A move that happened during the provider
      // call must not leave newly extracted facts on the previous job.
      const currentNote = await tx.rawNote.update({
        where: { id: transcript.noteId },
        data: { serverStatus: 'EXTRACTED' },
        select: { jobId: true },
      })
      if (!currentNote.jobId) throw new Error('Filed note lost its job')
      await tx.transcript.update({
        where: claimWhere,
        data: {
          extractionStatus: 'COMPLETED',
          extractionProvider: result ? provider.name : null,
          extractionModel: result ? provider.model : null,
          extractionSchemaVersion: result?.schemaVersion,
          extractionCompletedAt: new Date(),
        },
      })

      // Delete any facts from a prior partial run before re-creating them atomically
      await tx.candidateFact.deleteMany({
        where: { sourceTranscriptId: transcriptId },
      })

      for (const fact of guardedFacts) {
        const isUnclear = fact.factType === 'unclear'
        await tx.candidateFact.create({
          data: {
            jobId: currentNote.jobId,
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
            ...(result?.schemaVersion !== 'v3-job-memory' &&
            isMoneyFeaturesEnabled()
              ? {
                  costAmount: fact.costAmount ?? null,
                  costCurrency: fact.costCurrency ?? null,
                  costQualifier: fact.costQualifier ?? null,
                  totalCostAmount: deriveSafeTotalCost(fact) ?? null,
                }
              : {}),
            labourHours: fact.labourHours ?? null,
            labourPerson: fact.labourPerson ?? null,
            labourTask: fact.labourTask ?? null,
            happenedAt: resolveHappenedAt(fact, transcript.note.capturedAt),
            confidenceLabel: toDbConfidence(fact.confidenceLabel) as never,
            confidenceReason: fact.confidenceReason,
            uncertaintyFlags: resolveUncertaintyFlags(fact),
            extractionProvider: provider.name,
            extractionModel: provider.model,
            extractionSchemaVersion: result?.schemaVersion,
          },
        })
      }
    })
  } catch (err: unknown) {
    const errorCode = (err as { code?: string })?.code ?? 'UNKNOWN'
    const errorMessage = (err as { message?: string })?.message ?? String(err)

    // Failure and note state are fenced by the same claim as successful output.
    await prisma
      .$transaction(async (tx) => {
        await tx.rawNote.update({
          where: { id: transcript.noteId },
          data: { serverStatus: 'TRANSCRIBED' },
        })
        await tx.transcript.update({
          where: claimWhere,
          data: {
            extractionStatus: 'FAILED',
            extractionErrorCode: errorCode,
            extractionErrorMessage: errorMessage,
            extractionCompletedAt: new Date(),
          },
        })
      })
      .catch(() => {})
  }
}

// Filing and completed transcription both call this. The conditional database
// claim in runExtraction is the only way either trigger starts a provider call.
export async function triggerFiledExtraction(
  noteId: string,
  provider: ExtractionProvider,
) {
  const transcript = await prisma.transcript.findFirst({
    where: { noteId, note: { jobId: { not: null } } },
    orderBy: [...latestTranscriptOrder],
    select: { id: true },
  })
  if (transcript) await runExtraction(transcript.id, provider)
}
