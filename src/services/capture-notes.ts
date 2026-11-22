import type { Prisma, FactType } from '@prisma/client'
import { prisma } from '../db/client.js'
import {
  captureError,
  lockNote,
  requireFileableJob,
} from './capture-ownership.js'
import { latestTranscript } from './capture-home.js'
import { computeQueueItemId, deriveFreshQueueSections } from './review-queue.js'
import { materialAmount, withoutMoney } from '../lib/job-memory.js'
import { ukLocalDayString, ukLocalNoon } from '../lib/dates.js'

const materialStates = {
  ordered_material: 'bought',
  used_material: 'used',
  leftover_material: 'left_over',
  returned_material: 'returned',
} as const

type DraftMemory = {
  memoryType: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  locationOrUse: string | null
  deliveryTiming: string | null
  labourHours: string | null
  labourPerson: string | null
  labourTask: string | null
  happenedAt: string | null
}

async function getNoteChecks(
  jobId: string,
  noteId: string,
  db: Pick<Prisma.TransactionClient, 'candidateFact'> = prisma,
) {
  const { items, factMap } = await deriveFreshQueueSections(
    jobId,
    new Date(),
    false,
    db,
  )
  const singles = []
  let moreToCheckCount = 0
  for (const item of items) {
    const count = item.sourceCandidateFactIds.filter(
      (id) => factMap.get(id)?.sourceNoteId === noteId,
    ).length
    if (!count) continue
    if (item.kind === 'SINGLE' && item.sourceCandidateFactIds.length === 1) {
      singles.push({
        ...item,
        proposedMemory: withoutMoney(item.proposedMemory as DraftMemory),
      })
    } else moreToCheckCount += count
  }
  return { singles, moreToCheckCount }
}

export async function getNoteDraft(noteId: string, userId: string) {
  const note = await prisma.rawNote.findFirst({
    where: { id: noteId, ownerUserId: userId },
    include: {
      transcripts: { orderBy: [...latestTranscript.orderBy], take: 1 },
      owner: { select: { name: true } },
    },
  })
  if (!note) throw captureError('NOTE_NOT_FOUND', 'Note not found')

  const t = note.transcripts[0]
  const state = !note.jobId
    ? 'not_filed'
    : t?.status === 'FAILED' ||
        (t?.text?.trim() && t.extractionStatus === 'FAILED')
      ? 'failed'
      : t?.status !== 'COMPLETED'
        ? 'transcribing'
        : !t.text?.trim() || t.extractionStatus === 'COMPLETED'
          ? 'ready'
          : 'extracting'
  const items = []
  let moreToCheckCount = 0
  if (state === 'ready' && note.jobId && t?.text?.trim()) {
    const checks = await getNoteChecks(note.jobId, noteId)
    moreToCheckCount = checks.moreToCheckCount
    for (const item of checks.singles) {
      const uncertain = item.uncertaintyFlags.length > 0
      const pm = item.proposedMemory
      if (pm.memoryType === 'labour') {
        const person = pm.labourPerson?.trim()
        items.push({
          queueItemId: item.id,
          kind: 'hours',
          uncertain,
          person:
            !person || /^(me|i|myself)$/i.test(person)
              ? note.owner.name
              : person,
          hours: pm.labourHours,
          day: ukLocalDayString(
            pm.happenedAt ? new Date(pm.happenedAt) : note.capturedAt,
          ),
        })
      } else {
        items.push({
          queueItemId: item.id,
          kind: 'material',
          uncertain,
          state: materialStates[pm.memoryType as keyof typeof materialStates],
          item: pm.materialName,
          amount: materialAmount(pm),
          supplier: pm.supplierName,
          notes: pm.locationOrUse,
        })
      }
    }
  }
  return {
    noteId,
    jobId: note.jobId,
    state,
    transcriptText: t?.status === 'COMPLETED' ? t.text : null,
    items,
    moreToCheckCount,
  }
}

async function confirmDraft(noteId: string, userId: string, ids: string[]) {
  return prisma.$transaction(
    async (tx) => {
      const note = await lockNote(tx, noteId, userId)
      if (!note.jobId)
        throw captureError('NOTE_NOT_FILED', 'File this note first')
      const jobId = note.jobId
      const { singles } = await getNoteChecks(jobId, noteId, tx)
      const visible = new Map(singles.map((item) => [item.id, item]))
      const persisted = new Map(
        (
          await tx.queueItem.findMany({ where: { jobId, id: { in: ids } } })
        ).map((row) => [row.id, row]),
      )
      const facts = await tx.candidateFact.findMany({
        where: { sourceNoteId: noteId },
        select: { id: true, status: true },
      })
      const noteFacts = new Set(facts.map((f) => f.id))
      const singleIds = new Map(
        facts.map((f) => [computeQueueItemId(jobId, [f.id]), f.status]),
      )
      const confirmed: string[] = []
      const alreadyDecided: string[] = []
      for (const id of ids) {
        const prior = persisted.get(id)
        const item = visible.get(id)
        if (
          prior &&
          prior.status !== 'draft' &&
          prior.sourceCandidateFactIds.length &&
          prior.sourceCandidateFactIds.every((f) => noteFacts.has(f))
        ) {
          alreadyDecided.push(id)
          continue
        }
        if (!item) {
          const status = singleIds.get(id)
          if (
            status === 'CONFIRMED' ||
            status === 'CORRECTED' ||
            status === 'REJECTED'
          ) {
            alreadyDecided.push(id)
            continue
          }
          if (
            status ||
            prior?.sourceCandidateFactIds.some((f) => noteFacts.has(f))
          ) {
            throw captureError(
              'DRAFT_CHANGED',
              'What was picked out has changed. Refresh the draft to check it again.',
            )
          }
          throw captureError(
            'INVALID_FIELD',
            'Each queue item must belong to this note',
          )
        }
        await tx.queueItem.createMany({
          data: [item as Prisma.QueueItemCreateManyInput],
          skipDuplicates: true,
        })
        const claim = await tx.queueItem.updateMany({
          where: { id, jobId, status: 'draft' },
          data: { status: 'confirmed' },
        })
        if (!claim.count) {
          alreadyDecided.push(id)
          continue
        }
        const { sourceCandidateFactIds } = item
        const decision = await tx.reviewDecision.create({
          data: {
            jobId,
            decidedBy: userId,
            action: 'NOTE_LOOKS_RIGHT',
            candidateFactId: sourceCandidateFactIds[0],
            sourceCandidateFactIds,
          },
        })
        const pm = item.proposedMemory
        await tx.memoryItem.create({
          data: {
            jobId,
            reviewDecisionId: decision.id,
            sourceCandidateFactId: sourceCandidateFactIds[0],
            memoryType: pm.memoryType.toUpperCase() as FactType,
            summary: pm.summary,
            unresolvedFlags: item.uncertaintyFlags,
            materialName: pm.materialName,
            quantity: pm.quantity,
            unit: pm.unit,
            supplierName: pm.supplierName,
            locationOrUse: pm.locationOrUse,
            deliveryTiming: pm.deliveryTiming,
            labourHours: pm.labourHours,
            labourPerson: pm.labourPerson,
            labourTask: pm.labourTask,
            happenedAt: pm.happenedAt
              ? new Date(pm.happenedAt)
              : ['labour', 'ordered_material'].includes(pm.memoryType)
                ? ukLocalNoon(ukLocalDayString(note.capturedAt))
                : null,
          },
        })
        await tx.candidateFact.updateMany({
          where: { id: { in: sourceCandidateFactIds } },
          data: { status: 'CONFIRMED' },
        })
        confirmed.push(id)
      }
      return { confirmed, alreadyDecided }
    },
    { isolationLevel: 'Serializable' },
  )
}

export async function looksRight(
  noteId: string,
  userId: string,
  ids: string[],
) {
  // A simultaneous Looks right or per-item decision may win the serializable
  // transaction. Re-derive from committed state so a retry reports decided ids.
  for (let attempt = 0; ; attempt++) {
    try {
      return await confirmDraft(noteId, userId, ids)
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2034' || attempt === 2)
        throw error
    }
  }
}

export async function moveNote(
  noteId: string,
  userId: string,
  toJobId: string,
) {
  return prisma.$transaction(async (tx) => {
    const note = await lockNote(tx, noteId, userId)
    await requireFileableJob(tx, toJobId, userId)
    const fromJobId = note.jobId
    if (!fromJobId)
      throw captureError('NOTE_NOT_FILED', 'File this note before moving it')
    if (fromJobId === toJobId) return note
    const facts = await tx.candidateFact.findMany({
      where: { sourceNoteId: noteId },
      select: { id: true },
    })
    const factIds = facts.map((f) => f.id)
    const ownFacts = new Set(factIds)
    // Lock materialised queue rows before inspecting decisions. A concurrent
    // per-item decision must commit before this transaction can move its rows.
    if (factIds.length)
      await tx.$queryRaw`
      SELECT id FROM "queue_items" WHERE "jobId" = ${fromJobId}
        AND "sourceCandidateFactIds" && ${factIds}::text[] ORDER BY id FOR UPDATE
    `
    const decisions = await tx.reviewDecision.findMany({
      where: {
        jobId: fromJobId,
        OR: [
          { candidateFactId: { in: factIds } },
          { sourceCandidateFactIds: { hasSome: factIds } },
        ],
      },
    })
    const queues = await tx.queueItem.findMany({
      where: { jobId: fromJobId, sourceCandidateFactIds: { hasSome: factIds } },
    })
    const shared = (row: { sourceCandidateFactIds: string[] }) =>
      row.sourceCandidateFactIds.some((id) => !ownFacts.has(id))
    if (
      decisions.some(shared) ||
      queues.some((q) => q.status !== 'draft' && shared(q))
    ) {
      throw captureError(
        'NOTE_MOVE_BLOCKED',
        "This note was checked together with another recording, so it can't be moved on its own.",
      )
    }
    const decisionIds = new Set(decisions.map((d) => d.id))
    const sources = await tx.memoryItem.findMany({
      where: {
        jobId: fromJobId,
        OR: [
          { sourceCandidateFactId: { in: factIds } },
          { reviewDecisionId: { in: [...decisionIds] } },
        ],
      },
      select: { id: true },
    })
    const sourceIds = sources.map((m) => m.id)
    if (sourceIds.length) {
      // A return updates its source leftover in the same transaction. Lock
      // source rows before reading returns so a committed return moves too.
      await tx.$queryRaw`
        SELECT id FROM "memory_items" WHERE id = ANY(${sourceIds}::text[])
          ORDER BY id FOR UPDATE
      `
    }
    const memory = await tx.memoryItem.findMany({
      where: {
        jobId: fromJobId,
        OR: [
          { id: { in: sourceIds } },
          {
            memoryType: 'RETURNED_MATERIAL',
            returnedFromMemoryItemId: { in: sourceIds },
          },
        ],
      },
      select: {
        id: true,
        reviewDecisionId: true,
        labourPersonId: true,
        budgetCategoryId: true,
      },
    })
    for (const item of memory) decisionIds.add(item.reviewDecisionId)
    const memoryIds = [...new Set(memory.map((m) => m.id))]
    if (
      memory.some((m) => m.labourPersonId || m.budgetCategoryId) ||
      (await tx.jobMoneyEvent.count({
        where: { sourceMemoryItemId: { in: memoryIds } },
      }))
    ) {
      throw captureError(
        'NOTE_MOVE_BLOCKED',
        "This note has older records that can't be moved",
      )
    }
    await tx.candidateFact.updateMany({
      where: { id: { in: factIds } },
      data: { jobId: toJobId },
    })
    // A shared draft is only a cached projection. Both queues rederive it from
    // their candidate facts after the move, leaving the historical row intact.
    await tx.queueItem.updateMany({
      where: { id: { in: queues.filter((q) => !shared(q)).map((q) => q.id) } },
      data: { jobId: toJobId },
    })
    await tx.reviewDecision.updateMany({
      where: { id: { in: [...decisionIds] } },
      data: { jobId: toJobId },
    })
    await tx.memoryItem.updateMany({
      where: { id: { in: memoryIds } },
      data: { jobId: toJobId },
    })
    await tx.workshopItem.updateMany({
      where: { sourceMemoryItemId: { in: memoryIds } },
      data: { sourceJobId: toJobId },
    })
    await tx.jobPhoto.updateMany({
      where: {
        jobId: fromJobId,
        OR: [
          { linkedNoteId: noteId },
          { linkedMemoryItemId: { in: memoryIds } },
        ],
      },
      data: { jobId: toJobId },
    })
    await tx.itemMove.create({
      data: { ownerUserId: userId, kind: 'NOTE', noteId, fromJobId, toJobId },
    })
    return tx.rawNote.update({
      where: { id: noteId },
      data: { jobId: toJobId },
    })
  })
}
