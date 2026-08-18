// Workshop: what Mike thinks he may still have, and which job it came from.
//
// Workshop is availability memory. It is NOT inventory (nothing here guarantees
// stock, subtracts quantities or does unit arithmetic) and it is NOT finance:
// no route in this module writes to a memory item, a Budget category, a Money
// event, a payment or a job. Every Workshop action touches exactly one
// `workshop_items` row, and the source leftover's Workshop state in job read
// models is DERIVED from that row rather than copied onto it. That is what
// makes the finance invariant and the "no contradictory state after a failed
// action" rule structural rather than something tests have to police.
//
// One row per source leftover for its whole life: an undo or a terminal outcome
// leaves the row behind carrying the latest wording, and moving the same
// leftover again reactivates it instead of creating a second availability
// record. A partial unique index (one AVAILABLE row per source memory item)
// enforces that under concurrent duplicate requests too.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { buildMemoryViewItem } from './memory-view.js'
import type { LinkedWorkshopItem } from './memory-view.js'
import {
  MANUAL_SOURCE_LABEL,
  MOVABLE_SOURCE_STATES,
  TERMINAL_STATES,
  WORKSHOP_JOB_STATUS_LABELS,
  availableCountLabel,
  normalizeRoughAmount,
  roughAmountFromSource,
  toWireState,
  workshopDateLabel,
} from '../lib/workshop.js'
import type { StoredWorkshopState, WireWorkshopState } from '../lib/workshop.js'

export const MAX_MATERIAL_NAME_LENGTH = 120
export const MAX_ROUGH_AMOUNT_LENGTH = 120

// Book Home shows at most three of the same available items the Workshop page
// lists — the preview is a slice of one list, never a second query.
const PREVIEW_LIMIT = 3

// ── Response types ────────────────────────────────────────────────────────────

export interface WorkshopItemResponse {
  id: string
  materialName: string
  roughAmount: string | null
  sourceKind: 'leftover' | 'manual'
  state: WireWorkshopState
  enteredWorkshopAt: Date
  enteredWorkshopLabel: string
  resolvedAt: Date | null
  resolvedLabel: string | null
  sourceJobId: string | null
  sourceJobTitle: string | null
  sourceJobStatus: string | null
  sourceJobStatusLabel: string | null
  sourceMemoryItemId: string | null
  sourceItemLabel: string | null
  sourceLabel: string
}

export interface WorkshopPreviewItem {
  id: string
  materialName: string
  roughAmount: string | null
  sourceLabel: string
}

export interface WorkshopResponse {
  generatedAt: string
  bookHome: {
    showWorkshopRow: boolean
    availableCount: number
    availableLabel: string | null
    previewItems: WorkshopPreviewItem[]
  }
  availableItems: WorkshopItemResponse[]
}

export interface WorkshopActionResponse {
  workshopItem: WorkshopItemResponse
  sourceItem: ReturnType<typeof buildMemoryViewItem> | null
}

// ── Projection ────────────────────────────────────────────────────────────────

const WORKSHOP_INCLUDE = {
  sourceJob: { select: { id: true, title: true, status: true } },
  sourceMemoryItem: { select: { id: true, materialName: true, summary: true } },
} as const

type WorkshopRow = {
  id: string
  materialName: string
  roughAmount: string | null
  sourceKind: string
  state: string
  enteredWorkshopAt: Date
  resolvedAt: Date | null
  sourceJobId: string | null
  sourceMemoryItemId: string | null
  sourceJob: { id: string; title: string; status: string } | null
  sourceMemoryItem: { id: string; materialName: string | null; summary: string } | null
}

function projectWorkshopItem(row: WorkshopRow, now: Date): WorkshopItemResponse {
  const jobStatus = row.sourceJob ? row.sourceJob.status.toLowerCase() : null
  return {
    id: row.id,
    materialName: row.materialName,
    roughAmount: row.roughAmount,
    sourceKind: row.sourceKind.toLowerCase() as 'leftover' | 'manual',
    state: toWireState(row.state as StoredWorkshopState),
    enteredWorkshopAt: row.enteredWorkshopAt,
    enteredWorkshopLabel: workshopDateLabel(row.enteredWorkshopAt, now),
    resolvedAt: row.resolvedAt,
    resolvedLabel: row.resolvedAt ? workshopDateLabel(row.resolvedAt, now) : null,
    sourceJobId: row.sourceJobId,
    sourceJobTitle: row.sourceJob?.title ?? null,
    sourceJobStatus: jobStatus,
    sourceJobStatusLabel: jobStatus ? (WORKSHOP_JOB_STATUS_LABELS[jobStatus] ?? null) : null,
    sourceMemoryItemId: row.sourceMemoryItemId,
    sourceItemLabel: row.sourceMemoryItem
      ? (row.sourceMemoryItem.materialName ?? row.sourceMemoryItem.summary)
      : null,
    // Where this came from, in one string a row can print: the source job, or
    // "Added by hand" when there is no job behind it.
    sourceLabel: row.sourceJob?.title ?? MANUAL_SOURCE_LABEL,
  }
}

function linkedWorkshop(row: WorkshopRow): LinkedWorkshopItem {
  return {
    id: row.id,
    state: row.state,
    roughAmount: row.roughAmount,
    enteredWorkshopAt: row.enteredWorkshopAt,
    resolvedAt: row.resolvedAt,
  }
}

// The source leftover exactly as the memory view would return it, with its
// Workshop state derived from `row`. Read-only: loads and projects, writes
// nothing. Null when the Workshop item has no source (hand-added) or the source
// memory item has since been removed from the job record.
async function loadSourceItem(row: WorkshopRow) {
  if (!row.sourceMemoryItemId) return null
  const memoryItem = await prisma.memoryItem.findFirst({
    where: { id: row.sourceMemoryItemId, isRemoved: false },
    include: {
      sourceFact: {
        include: { sourceNote: { select: { id: true, capturedAt: true } }, transcript: true },
      },
    },
  })
  if (!memoryItem) return null
  const paidEvent = await prisma.jobMoneyEvent.findFirst({
    where: { sourceMemoryItemId: memoryItem.id, kind: 'COST_PAID', isDeleted: false },
    select: { id: true, occurredAt: true },
  })
  return buildMemoryViewItem(memoryItem, paidEvent, linkedWorkshop(row))
}

async function actionResponse(row: WorkshopRow, now: Date): Promise<WorkshopActionResponse> {
  return { workshopItem: projectWorkshopItem(row, now), sourceItem: await loadSourceItem(row) }
}

// ── Read model ────────────────────────────────────────────────────────────────

export async function getWorkshop(userId: string): Promise<WorkshopResponse> {
  const now = new Date()
  const rows = await prisma.workshopItem.findMany({
    where: { ownerUserId: userId, state: 'AVAILABLE' },
    include: WORKSHOP_INCLUDE,
    // Newest in the workshop first; id as the tie-break so two items entered in
    // the same millisecond never swap places between reads.
    orderBy: [{ enteredWorkshopAt: 'desc' }, { id: 'asc' }],
  })

  const availableItems = rows.map((row) => projectWorkshopItem(row, now))

  return {
    generatedAt: now.toISOString(),
    bookHome: {
      // The Workshop is a usable destination in this slice even when it is
      // empty, so the row is always offered — it just carries no count or
      // preview copy, never a "0 things" that reads as a finding.
      showWorkshopRow: true,
      availableCount: availableItems.length,
      availableLabel: availableCountLabel(availableItems.length),
      previewItems: availableItems.slice(0, PREVIEW_LIMIT).map((item) => ({
        id: item.id,
        materialName: item.materialName,
        roughAmount: item.roughAmount,
        sourceLabel: item.sourceLabel,
      })),
    },
    availableItems,
  }
}

// ── Move a source leftover in ─────────────────────────────────────────────────

// Job statuses a leftover can be moved to the Workshop from. Finished is
// deliberately included: leftovers from a finished job are exactly the material
// most likely to be sitting in the workshop, and moving one must not (and here
// cannot) reopen the job. Archived is the only status refused.
const MOVABLE_JOB_STATUSES = new Set(['PLANNING', 'STARTED', 'FINISHED'])

export async function moveLeftoverToWorkshop(
  jobId: string,
  memoryItemId: string,
  userId: string,
  input: { roughAmount?: unknown } = {},
): Promise<WorkshopActionResponse> {
  const now = new Date()

  const memoryItem = await prisma.memoryItem.findFirst({
    where: { id: memoryItemId, jobId },
    select: {
      id: true,
      jobId: true,
      memoryType: true,
      materialName: true,
      summary: true,
      quantity: true,
      unit: true,
      isRemoved: true,
      job: { select: { id: true, ownerUserId: true, status: true } },
    },
  })
  if (!memoryItem) throw notFoundSource()
  // Ownership is answered before anything else about the item is revealed, so a
  // wrong owner cannot probe which ids exist.
  if (memoryItem.job.ownerUserId !== userId) {
    throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  }
  if (memoryItem.isRemoved) throw notFoundSource()
  if (memoryItem.memoryType !== 'LEFTOVER_MATERIAL') {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Only a confirmed leftover material can be moved to the Workshop',
    }
  }
  if (!MOVABLE_JOB_STATUSES.has(memoryItem.job.status)) {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Leftovers from an archived job cannot be moved to the Workshop',
    }
  }

  const existing = await prisma.workshopItem.findFirst({
    where: { sourceMemoryItemId: memoryItemId, ownerUserId: userId },
    include: WORKSHOP_INCLUDE,
    orderBy: [{ enteredWorkshopAt: 'desc' }, { id: 'asc' }],
  })
  if (existing && !MOVABLE_SOURCE_STATES.has(existing.state as StoredWorkshopState)) {
    throw {
      code: ErrorCode.WORKSHOP_SOURCE_ALREADY_MOVED,
      message: 'This leftover is already in the Workshop',
    }
  }

  // Omitted amount falls back to the wording already in play: the last Workshop
  // wording for this material if there is one, otherwise the source leftover's
  // own display amount. An explicitly blank amount stays blank — "I don't know
  // how much" is a valid answer, not missing data.
  const roughAmount =
    input.roughAmount === undefined
      ? (existing?.roughAmount ?? roughAmountFromSource(memoryItem.quantity, memoryItem.unit))
      : normalizeRoughAmount(input.roughAmount as string | null)

  const materialName = memoryItem.materialName?.trim() || memoryItem.summary

  try {
    const row = existing
      ? await prisma.workshopItem.update({
          where: { id: existing.id },
          data: {
            state: 'AVAILABLE',
            materialName,
            roughAmount,
            enteredWorkshopAt: now,
            resolvedAt: null,
            sourceJobId: memoryItem.jobId,
          },
          include: WORKSHOP_INCLUDE,
        })
      : await prisma.workshopItem.create({
          data: {
            ownerUserId: userId,
            materialName,
            roughAmount,
            sourceKind: 'LEFTOVER',
            sourceJobId: memoryItem.jobId,
            sourceMemoryItemId: memoryItem.id,
            state: 'AVAILABLE',
            enteredWorkshopAt: now,
          },
          include: WORKSHOP_INCLUDE,
        })
    return await actionResponse(row, now)
  } catch (err: unknown) {
    // Two concurrent moves of the same leftover: the partial unique index lets
    // exactly one through, and the loser is told the same thing a sequential
    // duplicate would have been told. Nothing partial has been written.
    if (isUniqueViolation(err)) {
      throw {
        code: ErrorCode.WORKSHOP_SOURCE_ALREADY_MOVED,
        message: 'This leftover is already in the Workshop',
      }
    }
    throw err
  }
}

function notFoundSource() {
  return { code: ErrorCode.WORKSHOP_SOURCE_NOT_FOUND, message: 'Source leftover not found' }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

// ── Add by hand ───────────────────────────────────────────────────────────────

// A hand-added Workshop item carries a material name and, optionally, rough
// wording. There is deliberately nowhere to put a supplier, a price, a Budget
// category, a location or a source job: adding material Mike happens to have is
// not a purchase, and must never become one.
export async function createManualWorkshopItem(
  userId: string,
  input: { materialName?: unknown; roughAmount?: unknown },
): Promise<WorkshopItemResponse> {
  const now = new Date()
  const materialName = typeof input.materialName === 'string' ? input.materialName.trim() : ''
  if (!materialName) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'materialName is required' }
  }
  if (materialName.length > MAX_MATERIAL_NAME_LENGTH) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: `materialName must be at most ${MAX_MATERIAL_NAME_LENGTH} characters`,
    }
  }
  const roughAmount = validatedRoughAmount(input.roughAmount)

  const row = await prisma.workshopItem.create({
    data: {
      ownerUserId: userId,
      materialName,
      roughAmount,
      sourceKind: 'MANUAL',
      state: 'AVAILABLE',
      enteredWorkshopAt: now,
    },
    include: WORKSHOP_INCLUDE,
  })
  return projectWorkshopItem(row, now)
}

function validatedRoughAmount(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw { code: ErrorCode.INVALID_FIELD, message: 'roughAmount must be a string or null' }
  }
  if (value.trim().length > MAX_ROUGH_AMOUNT_LENGTH) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: `roughAmount must be at most ${MAX_ROUGH_AMOUNT_LENGTH} characters`,
    }
  }
  return normalizeRoughAmount(value)
}

// ── Change what's there ───────────────────────────────────────────────────────

export async function patchWorkshopItem(
  userId: string,
  workshopItemId: string,
  patch: { materialName?: unknown; roughAmount?: unknown },
): Promise<WorkshopItemResponse> {
  const now = new Date()
  if (!('materialName' in patch) && !('roughAmount' in patch)) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'materialName or roughAmount is required' }
  }

  const existing = await loadOwnedItem(userId, workshopItemId)
  if (existing.state !== 'AVAILABLE') {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Only an item currently in the Workshop can be changed',
    }
  }

  const data: { materialName?: string; roughAmount?: string | null } = {}

  if ('materialName' in patch) {
    // A source-linked item's name is the source memory's name. Correcting it
    // here would put two different names on one remembered material, so the
    // correction belongs on the source item where the evidence is.
    if (existing.sourceKind === 'LEFTOVER') {
      throw {
        code: ErrorCode.INVALID_FIELD,
        message: 'materialName can only be changed on a hand-added Workshop item; correct the source item instead',
      }
    }
    const materialName = typeof patch.materialName === 'string' ? patch.materialName.trim() : ''
    if (!materialName) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'materialName must be a non-empty string' }
    }
    if (materialName.length > MAX_MATERIAL_NAME_LENGTH) {
      throw {
        code: ErrorCode.INVALID_FIELD,
        message: `materialName must be at most ${MAX_MATERIAL_NAME_LENGTH} characters`,
      }
    }
    data.materialName = materialName
  }

  if ('roughAmount' in patch) data.roughAmount = validatedRoughAmount(patch.roughAmount)

  const row = await prisma.workshopItem.update({
    where: { id: existing.id },
    data,
    include: WORKSHOP_INCLUDE,
  })
  return projectWorkshopItem(row, now)
}

// ── Lifecycle actions ─────────────────────────────────────────────────────────

// Undo a move: the material was never really moved, so the source leftover goes
// straight back to "not moved". The row stays behind carrying the latest
// wording, which is what a later move restores.
export async function undoMoveWorkshopItem(userId: string, workshopItemId: string) {
  const existing = await loadOwnedItem(userId, workshopItemId)
  if (existing.sourceKind !== 'LEFTOVER') {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Only a Workshop item moved from a job leftover can have its move undone',
    }
  }
  return resolveTo(existing, 'MOVED_BACK', { resolvedAt: null })
}

// All used up: the material really was there and has now been used. Terminal,
// but recoverable — the source purchase, its cost and its paid state are
// untouched either way.
export async function markWorkshopItemUsedUp(userId: string, workshopItemId: string) {
  return resolveTo(await loadOwnedItem(userId, workshopItemId), 'USED_UP')
}

// Wasn't there after all: a correction to the availability memory, not to the
// purchase. Mike still bought it — he just hasn't got it.
export async function markWorkshopItemWasntThere(userId: string, workshopItemId: string) {
  return resolveTo(await loadOwnedItem(userId, workshopItemId), 'WASNT_THERE')
}

async function resolveTo(
  existing: WorkshopRow & { sourceKind: string },
  state: StoredWorkshopState,
  extra: { resolvedAt?: Date | null } = {},
) {
  const now = new Date()
  if (existing.state !== 'AVAILABLE') {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Only an item currently in the Workshop can be resolved',
    }
  }
  const row = await prisma.workshopItem.update({
    where: { id: existing.id },
    data: { state, resolvedAt: 'resolvedAt' in extra ? extra.resolvedAt : now },
    include: WORKSHOP_INCLUDE,
  })
  return actionResponse(row, now)
}

// Put back in the Workshop: the same row returns to available with the wording
// it had, so nothing is duplicated and nothing has to be retyped.
export async function putWorkshopItemBack(userId: string, workshopItemId: string) {
  const now = new Date()
  const existing = await loadOwnedItem(userId, workshopItemId)
  if (!TERMINAL_STATES.has(existing.state as StoredWorkshopState)) {
    throw {
      code: ErrorCode.WORKSHOP_INVALID_STATE,
      message: 'Only an item marked all used up or wasn\'t there can be put back',
    }
  }
  try {
    const row = await prisma.workshopItem.update({
      where: { id: existing.id },
      data: { state: 'AVAILABLE', resolvedAt: null, enteredWorkshopAt: now },
      include: WORKSHOP_INCLUDE,
    })
    return await actionResponse(row, now)
  } catch (err: unknown) {
    // Another available row appeared for the same source in between: the put
    // back is refused rather than creating a second availability record.
    if (isUniqueViolation(err)) {
      throw {
        code: ErrorCode.WORKSHOP_SOURCE_ALREADY_MOVED,
        message: 'This leftover is already in the Workshop',
      }
    }
    throw err
  }
}

// Owner-scoped load. A Workshop item belonging to someone else is reported as
// not found, never as forbidden — Mike's book should not confirm that another
// user's id exists.
async function loadOwnedItem(userId: string, workshopItemId: string) {
  const row = await prisma.workshopItem.findFirst({
    where: { id: workshopItemId, ownerUserId: userId },
    include: WORKSHOP_INCLUDE,
  })
  if (!row) throw { code: ErrorCode.WORKSHOP_ITEM_NOT_FOUND, message: 'Workshop item not found' }
  return row
}
