// Workshop core from real leftovers: availability memory over confirmed
// leftovers and hand-added material.
//
// These tests pin the things that would be release-blocking if they broke — the
// finance invariant (Budget and Money identical before and after EVERY Workshop
// action, source cost and paid state untouched), the one-availability-per-source
// rule, the two distinct terminal outcomes and their recovery, and the
// cross-user boundary — plus the read-model contract the frontend builds Book
// Home and the Workshop page from. Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'workshop-core-'
const WORKSHOP_URL = '/api/workshop'

let app: FastifyInstance
let ownerId: string
let otherOwnerId: string

let activeJobId: string
let finishedJobId: string
let archivedJobId: string
let otherUserJobId: string

// Active job: a bought-and-paid purchase (the finance fixture the invariant is
// measured against) plus two leftovers. Finished job: one leftover.
let boughtId: string
let leftoverId: string
let secondLeftoverId: string
let finishedLeftoverId: string
let archivedLeftoverId: string
let otherUserLeftoverId: string
let usedMaterialId: string

const authHeaders = (userId: string) => ({ 'x-pilot-user-id': userId })
const jsonHeaders = (userId: string) => ({ ...authHeaders(userId), 'content-type': 'application/json' })

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((u) => u.id)
  if (!userIds.length) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.workshopItem.deleteMany({ where: { ownerUserId: { in: userIds } } })
  if (jobIds.length) {
    await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobPayment.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function job(ownerUserId: string, title: string, status: string) {
  const created = await prisma.job.create({
    data: { ownerUserId, title, jobType: 'garden_room', status: status as never, customerTotalAmount: '5000', customerTotalCurrency: 'GBP' },
  })
  return created.id
}

// Direct-add through the real HTTP write path, so Workshop always runs against
// memory the app itself could have created.
async function addItem(jobId: string, userId: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/memory-items`,
    headers: jsonHeaders(userId),
    payload: body,
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json().id
}

const leftover = (materialName: string, quantity = '3', unit = 'sheets') => ({
  memoryType: 'leftover_material',
  materialName,
  quantity,
  unit,
  happenedAt: '2026-08-01',
})

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get(url: string, userId = ownerId) {
  const res = await app.inject({ method: 'GET', url, headers: authHeaders(userId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

const workshop = (userId = ownerId) => get(WORKSHOP_URL, userId)
const memoryView = (jobId: string, userId = ownerId) => get(`/api/jobs/${jobId}/memory-view`, userId)
const budgetSummary = (jobId: string, userId = ownerId) => get(`/api/jobs/${jobId}/budget-summary`, userId)
const jobMoney = (jobId: string, userId = ownerId) => get(`/api/jobs/${jobId}/money`, userId)

function post(url: string, userId = ownerId, payload?: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers: jsonHeaders(userId), payload: payload ?? {} })
}

function patch(url: string, userId = ownerId, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'PATCH', url, headers: jsonHeaders(userId), payload })
}

const moveUrl = (jobId: string, memoryItemId: string) =>
  `/api/jobs/${jobId}/memory-items/${memoryItemId}/workshop`

async function move(jobId: string, memoryItemId: string, payload?: Record<string, unknown>) {
  const res = await post(moveUrl(jobId, memoryItemId), ownerId, payload)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

async function addByHand(payload: Record<string, unknown>, userId = ownerId) {
  const res = await post('/api/workshop/items', userId, payload)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

async function act(workshopItemId: string, action: string, userId = ownerId) {
  const res = await post(`/api/workshop/items/${workshopItemId}/${action}`, userId)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

function leftoverRow(view: { sections: Array<{ key: string; items: Array<{ id: string }> }> }, id: string) {
  const section = view.sections.find((s) => s.key === 'leftovers')!
  return section.items.find((i) => i.id === id)
}

// ── Finance invariant ─────────────────────────────────────────────────────────

// Budget and Money must be byte-identical across a Workshop action apart from
// the read timestamps. Workshop writes nothing outside `workshop_items`, so
// there is no volatile payment state to allow for here — unlike settlement,
// which is allowed to move paid state, a Workshop action is allowed to move
// nothing at all.
const VOLATILE_KEYS = new Set(['generatedAt'])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE_KEYS.has(k))
        .map(([k, v]) => [k, stripVolatile(v)]),
    )
  }
  return value
}

const FINANCE_JOBS = () => [activeJobId, finishedJobId]

async function financeSnapshot() {
  const snapshot: Record<string, unknown> = {}
  for (const jobId of FINANCE_JOBS()) {
    snapshot[`budget:${jobId}`] = stripVolatile(await budgetSummary(jobId))
    snapshot[`money:${jobId}`] = stripVolatile(await jobMoney(jobId))
  }
  return snapshot
}

// Runs a Workshop action with Budget + Money snapshotted on both sides. Every
// mutating test goes through this, so the invariant is proved per action rather
// than once at the end.
async function withFinanceUnchanged<T>(run: () => Promise<T>): Promise<T> {
  const before = await financeSnapshot()
  const result = await run()
  expect(await financeSnapshot()).toEqual(before)
  return result
}

// The source item's own purchase/cost/paid fields, which no Workshop action may
// touch.
const SOURCE_FINANCE_KEYS = [
  'costAmount', 'costCurrency', 'costQualifier', 'totalCostAmount',
  'unitCostLabel', 'lineTotalLabel', 'isPaid', 'paidMoneyEventId', 'paidAt',
  'quantity', 'unit', 'supplierName', 'budgetCategoryId',
] as const

function financeFields(item: Record<string, unknown>) {
  return Object.fromEntries(SOURCE_FINANCE_KEYS.map((k) => [k, item[k]]))
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()

  const owner = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Mike' } })
  ownerId = owner.id
  const other = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}other@test.local`, name: 'Someone else' } })
  otherOwnerId = other.id
})

afterAll(async () => {
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  // Rebuild the fixture per test so state machine tests never leak into each
  // other; the two users survive.
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: [ownerId, otherOwnerId] } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.workshopItem.deleteMany({ where: { ownerUserId: { in: [ownerId, otherOwnerId] } } })
  if (jobIds.length) {
    await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  }

  activeJobId = await job(ownerId, 'Poole garden room', 'STARTED')
  finishedJobId = await job(ownerId, 'Wimborne extension', 'FINISHED')
  archivedJobId = await job(ownerId, 'Old shed', 'ARCHIVED')
  otherUserJobId = await job(otherOwnerId, 'Not Mike\'s job', 'STARTED')

  // A bought-and-paid purchase, so the finance snapshot has real Budget and
  // Money content to be unchanged.
  boughtId = await addItem(activeJobId, ownerId, {
    memoryType: 'ordered_material',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Sydenhams',
    costAmount: '240',
    costCurrency: 'GBP',
    costQualifier: 'total',
    happenedAt: '2026-08-01',
    markPaid: true,
  })
  leftoverId = await addItem(activeJobId, ownerId, leftover('plasterboard'))
  secondLeftoverId = await addItem(activeJobId, ownerId, leftover('insulation', '2', 'rolls'))
  usedMaterialId = await addItem(activeJobId, ownerId, { memoryType: 'used_material', materialName: 'screws', quantity: '1', unit: 'box' })
  finishedLeftoverId = await addItem(finishedJobId, ownerId, leftover('cedar cladding', 'about 5', 'boards'))
  archivedLeftoverId = await addItem(archivedJobId, ownerId, leftover('membrane'))
  otherUserLeftoverId = await addItem(otherUserJobId, otherOwnerId, leftover('timber'))
})

// ── Move a leftover in ────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/memory-items/:memoryItemId/workshop', () => {
  it('moves a confirmed leftover into the Workshop and leaves the source row visible', async () => {
    const result = await withFinanceUnchanged(() => move(activeJobId, leftoverId))

    expect(result.workshopItem).toMatchObject({
      materialName: 'plasterboard',
      // Amount defaults to the source leftover's own display wording.
      roughAmount: '3 sheets',
      sourceKind: 'leftover',
      state: 'available',
      sourceJobId: activeJobId,
      sourceJobTitle: 'Poole garden room',
      sourceJobStatus: 'started',
      sourceJobStatusLabel: 'In progress',
      sourceMemoryItemId: leftoverId,
      sourceItemLabel: 'plasterboard',
      sourceLabel: 'Poole garden room',
      resolvedAt: null,
      resolvedLabel: null,
    })
    expect(result.workshopItem.enteredWorkshopLabel).toBe('Today')

    // The response's source item and a fresh memory-view read agree.
    expect(result.sourceItem).toMatchObject({
      id: leftoverId,
      workshopState: 'in_workshop',
      workshopItemId: result.workshopItem.id,
      workshopRoughAmount: '3 sheets',
    })
    const row = leftoverRow(await memoryView(activeJobId), leftoverId)!
    expect(row).toMatchObject({ workshopState: 'in_workshop', workshopItemId: result.workshopItem.id })
    expect(row.workshopEnteredLabel).toBe('Today')
  })

  it('accepts a rough amount as free text and never sharpens it', async () => {
    const result = await move(activeJobId, leftoverId, { roughAmount: '  about half a box  ' })
    expect(result.workshopItem.roughAmount).toBe('about half a box')
  })

  it('treats a blank rough amount as not known rather than as zero', async () => {
    const result = await move(activeJobId, leftoverId, { roughAmount: '   ' })
    expect(result.workshopItem.roughAmount).toBeNull()
  })

  it('moves a Finished job leftover without changing the job status', async () => {
    const before = await get(`/api/jobs/${finishedJobId}`)
    const result = await withFinanceUnchanged(() => move(finishedJobId, finishedLeftoverId))

    expect(result.workshopItem).toMatchObject({
      sourceJobStatus: 'finished',
      sourceJobStatusLabel: 'Finished',
      roughAmount: 'about 5 boards',
    })
    expect(await get(`/api/jobs/${finishedJobId}`)).toEqual(before)
  })

  it('leaves the source purchase, cost and paid state exactly as they were', async () => {
    const beforeView = await memoryView(activeJobId)
    const beforeLeftover = financeFields(leftoverRow(beforeView, leftoverId)!)
    const beforeBought = beforeView.sections
      .find((s: { key: string }) => s.key === 'ordered_materials')!
      .items.find((i: { id: string }) => i.id === boughtId)!

    await move(activeJobId, leftoverId)

    const afterView = await memoryView(activeJobId)
    expect(financeFields(leftoverRow(afterView, leftoverId)!)).toEqual(beforeLeftover)
    const afterBought = afterView.sections
      .find((s: { key: string }) => s.key === 'ordered_materials')!
      .items.find((i: { id: string }) => i.id === boughtId)!
    expect(afterBought).toEqual(beforeBought)
    expect(afterBought.isPaid).toBe(true)
    expect(stripVolatile(afterView.costSummary)).toEqual(stripVolatile(beforeView.costSummary))
  })

  it('rejects a duplicate move while the leftover is already in the Workshop', async () => {
    const first = await move(activeJobId, leftoverId)

    const res = await post(moveUrl(activeJobId, leftoverId))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_SOURCE_ALREADY_MOVED')

    // The refused move changed nothing: still exactly one available item.
    const list = await workshop()
    expect(list.availableItems.map((i: { id: string }) => i.id)).toEqual([first.workshopItem.id])
  })

  it('lets exactly one of two concurrent duplicate moves through', async () => {
    const [a, b] = await Promise.all([post(moveUrl(activeJobId, leftoverId)), post(moveUrl(activeJobId, leftoverId))])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([201, 400])
    expect(await prisma.workshopItem.count({ where: { sourceMemoryItemId: leftoverId } })).toBe(1)
  })

  it('refuses a leftover from an archived job', async () => {
    const res = await post(moveUrl(archivedJobId, archivedLeftoverId))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
    expect((await workshop()).availableItems).toHaveLength(0)
  })

  it('refuses a memory item that is not a leftover', async () => {
    const res = await post(moveUrl(activeJobId, usedMaterialId))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
  })

  it('404s an unknown source item', async () => {
    const res = await post(moveUrl(activeJobId, '00000000-0000-0000-0000-000000000999'))
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('WORKSHOP_SOURCE_NOT_FOUND')
  })

  it('refuses another user\'s leftover and writes nothing', async () => {
    const res = await post(moveUrl(otherUserJobId, otherUserLeftoverId), ownerId)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')
    expect(await prisma.workshopItem.count({ where: { sourceMemoryItemId: otherUserLeftoverId } })).toBe(0)
  })
})

// ── Read model ────────────────────────────────────────────────────────────────

describe('GET /api/workshop', () => {
  it('offers the Book Home row with no count or preview when empty', async () => {
    const list = await workshop()
    expect(list.bookHome).toEqual({
      showWorkshopRow: true,
      availableCount: 0,
      availableLabel: null,
      previewItems: [],
    })
    expect(list.availableItems).toEqual([])
  })

  it('lists only available items, newest in first, and previews the same first three', async () => {
    // Four items, moved/added in a known order.
    const first = await move(activeJobId, leftoverId)
    const second = await move(activeJobId, secondLeftoverId)
    const third = await move(finishedJobId, finishedLeftoverId)
    const fourth = await addByHand({ materialName: 'offcuts of ply' })

    // One resolved and one undone item must not appear anywhere in the list.
    const resolved = await addByHand({ materialName: 'old sealant' })
    await act(resolved.id, 'used-up')

    const list = await workshop()
    const ids = list.availableItems.map((i: { id: string }) => i.id)
    expect(ids).toEqual([fourth.id, third.workshopItem.id, second.workshopItem.id, first.workshopItem.id])
    expect(ids).not.toContain(resolved.id)
    expect(list.availableItems.every((i: { state: string }) => i.state === 'available')).toBe(true)

    expect(list.bookHome.availableCount).toBe(4)
    expect(list.bookHome.availableLabel).toBe('4 things')
    // The preview IS the first three of the same list, not a second query.
    expect(list.bookHome.previewItems).toEqual(
      list.availableItems.slice(0, 3).map((i: { id: string; materialName: string; roughAmount: string | null; sourceLabel: string }) => ({
        id: i.id,
        materialName: i.materialName,
        roughAmount: i.roughAmount,
        sourceLabel: i.sourceLabel,
      })),
    )
  })

  it('labels a single available item as one thing', async () => {
    await addByHand({ materialName: 'a door' })
    expect((await workshop()).bookHome.availableLabel).toBe('1 thing')
  })

  it('labels a hand-added item as added by hand with no source job', async () => {
    const item = await addByHand({ materialName: 'offcuts of ply', roughAmount: 'part of a roll' })
    const [row] = (await workshop()).availableItems
    expect(row).toMatchObject({
      id: item.id,
      sourceKind: 'manual',
      sourceLabel: 'Added by hand',
      sourceJobId: null,
      sourceJobTitle: null,
      sourceJobStatus: null,
      sourceJobStatusLabel: null,
      sourceMemoryItemId: null,
      sourceItemLabel: null,
      roughAmount: 'part of a roll',
    })
  })

  it('never shows another user\'s Workshop material', async () => {
    await move(activeJobId, leftoverId)
    const theirs = await addByHand({ materialName: 'their timber' }, otherOwnerId)

    const mine = await workshop()
    expect(mine.availableItems.map((i: { id: string }) => i.id)).not.toContain(theirs.id)
    const theirList = await workshop(otherOwnerId)
    expect(theirList.availableItems.map((i: { id: string }) => i.id)).toEqual([theirs.id])
  })
})

// ── Add by hand ───────────────────────────────────────────────────────────────

describe('POST /api/workshop/items', () => {
  it('adds an item from a material name alone, with no job, source or finance fields', async () => {
    const item = await withFinanceUnchanged(() => addByHand({ materialName: '  loft insulation  ' }))
    expect(item).toMatchObject({
      materialName: 'loft insulation',
      roughAmount: null,
      sourceKind: 'manual',
      state: 'available',
      sourceJobId: null,
      sourceMemoryItemId: null,
    })

    // Nothing was created anywhere but the Workshop.
    const stored = await prisma.workshopItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(stored.sourceJobId).toBeNull()
    expect(stored.sourceMemoryItemId).toBeNull()
    expect(await prisma.memoryItem.count({ where: { jobId: activeJobId, materialName: 'loft insulation' } })).toBe(0)
  })

  it('keeps an approximate rough amount exactly as typed', async () => {
    const item = await addByHand({ materialName: 'screws', roughAmount: 'about half a box' })
    expect(item.roughAmount).toBe('about half a box')
  })

  it('ignores supplier, price, category, location and source job fields if sent', async () => {
    const item = await addByHand({
      materialName: 'timber',
      supplierName: 'Sydenhams',
      costAmount: '100',
      costCurrency: 'GBP',
      budgetCategoryId: 'anything',
      locationOrUse: 'top shelf',
      sourceJobId: activeJobId,
      sourceMemoryItemId: leftoverId,
    })
    expect(item.sourceJobId).toBeNull()
    expect(item.sourceMemoryItemId).toBeNull()
    expect(item.sourceKind).toBe('manual')
    expect(Object.keys(item)).not.toContain('costAmount')
    expect(Object.keys(item)).not.toContain('supplierName')
  })

  it('requires a material name', async () => {
    for (const payload of [{}, { materialName: '   ' }, { roughAmount: 'a few' }]) {
      const res = await post('/api/workshop/items', ownerId, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('MISSING_FIELD')
    }
  })
})

// ── Change what's there ───────────────────────────────────────────────────────

describe('PATCH /api/workshop/items/:workshopItemId', () => {
  it('changes the rough amount on a source-linked item and shows it on the source row', async () => {
    const moved = await move(activeJobId, leftoverId)

    const updated = await withFinanceUnchanged(async () => {
      const res = await patch(`/api/workshop/items/${moved.workshopItem.id}`, ownerId, { roughAmount: 'about 1 and a bit' })
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
      return res.json()
    })
    expect(updated.roughAmount).toBe('about 1 and a bit')

    const row = leftoverRow(await memoryView(activeJobId), leftoverId)!
    expect(row.workshopRoughAmount).toBe('about 1 and a bit')
    // The remembered purchase quantity is NOT the rough amount and did not move.
    expect(row.quantity).toBe('3')
    expect(row.unit).toBe('sheets')
  })

  it('clears the rough amount to blank rather than to zero', async () => {
    const item = await addByHand({ materialName: 'sealant', roughAmount: '4 or 5' })
    const res = await patch(`/api/workshop/items/${item.id}`, ownerId, { roughAmount: '' })
    expect(res.statusCode).toBe(200)
    expect(res.json().roughAmount).toBeNull()
  })

  it('renames a hand-added item but not a source-linked one', async () => {
    const manual = await addByHand({ materialName: 'ply' })
    const renamed = await patch(`/api/workshop/items/${manual.id}`, ownerId, { materialName: 'birch ply' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().materialName).toBe('birch ply')

    const moved = await move(activeJobId, leftoverId)
    const refused = await patch(`/api/workshop/items/${moved.workshopItem.id}`, ownerId, { materialName: 'something else' })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().code).toBe('INVALID_FIELD')
    const stored = await prisma.workshopItem.findUniqueOrThrow({ where: { id: moved.workshopItem.id } })
    expect(stored.materialName).toBe('plasterboard')
  })

  it('refuses to edit an item that is no longer in the Workshop', async () => {
    const item = await addByHand({ materialName: 'ply' })
    await act(item.id, 'used-up')

    const res = await patch(`/api/workshop/items/${item.id}`, ownerId, { roughAmount: 'some' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
    const stored = await prisma.workshopItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(stored.roughAmount).toBeNull()
    expect(stored.state).toBe('USED_UP')
  })

  it('404s another user\'s Workshop item and changes nothing', async () => {
    const theirs = await addByHand({ materialName: 'their timber' }, otherOwnerId)
    const res = await patch(`/api/workshop/items/${theirs.id}`, ownerId, { roughAmount: 'loads' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('WORKSHOP_ITEM_NOT_FOUND')
    expect((await prisma.workshopItem.findUniqueOrThrow({ where: { id: theirs.id } })).roughAmount).toBeNull()
  })
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('Workshop lifecycle', () => {
  it('undoes a move, restoring the source to not moved with the latest wording', async () => {
    const moved = await move(activeJobId, leftoverId)
    await patch(`/api/workshop/items/${moved.workshopItem.id}`, ownerId, { roughAmount: 'about 2 sheets' })

    const result = await withFinanceUnchanged(() => act(moved.workshopItem.id, 'undo-move'))
    expect(result.workshopItem.state).toBe('moved_back')

    expect((await workshop()).availableItems).toHaveLength(0)
    const row = leftoverRow(await memoryView(activeJobId), leftoverId)!
    expect(row.workshopState).toBe('not_moved')
    // The latest wording survives the undo, so moving again does not lose it.
    expect(row.workshopRoughAmount).toBe('about 2 sheets')

    const again = await move(activeJobId, leftoverId)
    expect(again.workshopItem.id).toBe(moved.workshopItem.id)
    expect(again.workshopItem.roughAmount).toBe('about 2 sheets')
    expect(again.workshopItem.state).toBe('available')
    expect(await prisma.workshopItem.count({ where: { sourceMemoryItemId: leftoverId } })).toBe(1)
  })

  it('refuses undo-move on a hand-added item', async () => {
    const item = await addByHand({ materialName: 'ply' })
    const res = await post(`/api/workshop/items/${item.id}/undo-move`)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
    expect((await prisma.workshopItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('AVAILABLE')
  })

  it('marks all used up and wasn\'t there as two distinct, separately recorded outcomes', async () => {
    const usedUp = await move(activeJobId, leftoverId)
    const missing = await move(activeJobId, secondLeftoverId)

    const usedUpResult = await withFinanceUnchanged(() => act(usedUp.workshopItem.id, 'used-up'))
    const missingResult = await withFinanceUnchanged(() => act(missing.workshopItem.id, 'wasnt-there'))

    expect(usedUpResult.workshopItem.state).toBe('used_up')
    expect(missingResult.workshopItem.state).toBe('wasnt_there')
    for (const result of [usedUpResult, missingResult]) {
      expect(result.workshopItem.resolvedAt).not.toBeNull()
      expect(result.workshopItem.resolvedLabel).toBe('Today')
    }

    expect((await workshop()).availableItems).toHaveLength(0)
    const view = await memoryView(activeJobId)
    expect(leftoverRow(view, leftoverId)!.workshopState).toBe('used_up')
    expect(leftoverRow(view, secondLeftoverId)!.workshopState).toBe('wasnt_there')
    expect(leftoverRow(view, secondLeftoverId)!.workshopResolvedLabel).toBe('Today')
  })

  it('leaves the source purchase untouched when material wasn\'t there after all', async () => {
    const beforeView = await memoryView(activeJobId)
    const beforeLeftover = financeFields(leftoverRow(beforeView, leftoverId)!)

    const moved = await move(activeJobId, leftoverId)
    await withFinanceUnchanged(() => act(moved.workshopItem.id, 'wasnt-there'))

    const afterView = await memoryView(activeJobId)
    expect(financeFields(leftoverRow(afterView, leftoverId)!)).toEqual(beforeLeftover)
    expect(stripVolatile(afterView.costSummary)).toEqual(stripVolatile(beforeView.costSummary))
  })

  it('puts a source-linked item back from both terminal states without duplicating it', async () => {
    for (const action of ['used-up', 'wasnt-there']) {
      const moved = await move(activeJobId, leftoverId, { roughAmount: 'half a pack' })
      await act(moved.workshopItem.id, action)
      expect((await workshop()).availableItems).toHaveLength(0)

      const back = await withFinanceUnchanged(() => act(moved.workshopItem.id, 'put-back'))
      expect(back.workshopItem).toMatchObject({
        id: moved.workshopItem.id,
        state: 'available',
        resolvedAt: null,
        resolvedLabel: null,
        // Last wording restored — nothing to retype.
        roughAmount: 'half a pack',
      })
      expect(leftoverRow(await memoryView(activeJobId), leftoverId)!.workshopState).toBe('in_workshop')
      expect((await workshop()).availableItems).toHaveLength(1)
      expect(await prisma.workshopItem.count({ where: { sourceMemoryItemId: leftoverId } })).toBe(1)

      // Reset for the second terminal state.
      await act(moved.workshopItem.id, 'undo-move')
    }
  })

  it('carries a hand-added item through its whole lifecycle', async () => {
    const item = await addByHand({ materialName: 'offcuts of ply', roughAmount: 'a few bits' })
    expect((await workshop()).availableItems).toHaveLength(1)

    const usedUp = await act(item.id, 'used-up')
    expect(usedUp.workshopItem.state).toBe('used_up')
    // A hand-added item has no source memory, so there is nothing to return.
    expect(usedUp.sourceItem).toBeNull()
    expect((await workshop()).availableItems).toHaveLength(0)

    const back = await act(item.id, 'put-back')
    expect(back.workshopItem).toMatchObject({ state: 'available', roughAmount: 'a few bits' })
    expect((await workshop()).availableItems).toHaveLength(1)
  })

  it('refuses put-back on an item that is already available', async () => {
    const item = await addByHand({ materialName: 'ply' })
    const res = await post(`/api/workshop/items/${item.id}/put-back`)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
  })

  it('refuses a second terminal action on an already-resolved item', async () => {
    const moved = await move(activeJobId, leftoverId)
    await act(moved.workshopItem.id, 'used-up')

    for (const action of ['used-up', 'wasnt-there', 'undo-move']) {
      const res = await post(`/api/workshop/items/${moved.workshopItem.id}/${action}`)
      expect(res.statusCode, action).toBe(400)
      expect(res.json().code).toBe('WORKSHOP_INVALID_STATE')
    }
    // The refused actions left the state and the source view exactly as they were.
    const stored = await prisma.workshopItem.findUniqueOrThrow({ where: { id: moved.workshopItem.id } })
    expect(stored.state).toBe('USED_UP')
    expect(leftoverRow(await memoryView(activeJobId), leftoverId)!.workshopState).toBe('used_up')
  })

  it('404s another user\'s item for every lifecycle action and changes nothing', async () => {
    const theirs = await addByHand({ materialName: 'their timber' }, otherOwnerId)
    for (const action of ['undo-move', 'used-up', 'wasnt-there', 'put-back']) {
      const res = await post(`/api/workshop/items/${theirs.id}/${action}`, ownerId)
      expect(res.statusCode, action).toBe(404)
      expect(res.json().code).toBe('WORKSHOP_ITEM_NOT_FOUND')
    }
    expect((await prisma.workshopItem.findUniqueOrThrow({ where: { id: theirs.id } })).state).toBe('AVAILABLE')
  })

  it('404s an unknown Workshop item', async () => {
    const res = await post('/api/workshop/items/00000000-0000-0000-0000-000000000999/used-up')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('WORKSHOP_ITEM_NOT_FOUND')
  })
})

// ── Source-side read model ────────────────────────────────────────────────────

describe('memory-view Workshop state', () => {
  it('reports not_moved with no Workshop fields for a leftover that was never moved', async () => {
    const row = leftoverRow(await memoryView(activeJobId), leftoverId)!
    expect(row).toMatchObject({
      workshopState: 'not_moved',
      workshopItemId: null,
      workshopRoughAmount: null,
      workshopEnteredAt: null,
      workshopEnteredLabel: null,
      workshopResolvedAt: null,
      workshopResolvedLabel: null,
    })
  })

  it('only marks the moved leftover, not its neighbours', async () => {
    await move(activeJobId, leftoverId)
    const view = await memoryView(activeJobId)
    expect(leftoverRow(view, leftoverId)!.workshopState).toBe('in_workshop')
    expect(leftoverRow(view, secondLeftoverId)!.workshopState).toBe('not_moved')
  })

  it('does not leak Workshop state across jobs', async () => {
    await move(finishedJobId, finishedLeftoverId)
    expect(leftoverRow(await memoryView(activeJobId), leftoverId)!.workshopState).toBe('not_moved')
    expect(leftoverRow(await memoryView(finishedJobId), finishedLeftoverId)!.workshopState).toBe('in_workshop')
  })
})
