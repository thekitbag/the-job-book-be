// Budget category reassignment as a correction, not a new workflow: moving a
// remembered cost item between categories (or to Uncategorised) redistributes
// the same known cost and must not change cost, paid state, the linked Money
// movement, or source evidence. Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'category-reassignment-'

let app: FastifyInstance
let ownerId: string
let otherOwnerId: string
let jobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((u) => u.id)
  if (!userIds.length) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Owner', role: 'PILOT' } })).id
  otherOwnerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}other@test.local`, name: 'Other', role: 'PILOT' } })).id
})

afterAll(async () => {
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  jobId = (await prisma.job.create({ data: { ownerUserId: ownerId, title: 'Reassignment job', jobType: 'garden_room' } })).id
})

const headers = () => ({ 'x-pilot-user-id': ownerId, 'content-type': 'application/json' })
const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-pilot-user-id': ownerId } })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: headers(), payload })
const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: headers(), payload })
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { 'x-pilot-user-id': ownerId } })

const memoryUrl = () => `/api/jobs/${jobId}/memory-items`
const budgetUrl = () => `/api/jobs/${jobId}/budget-summary`
const moneyUrl = () => `/api/jobs/${jobId}/money`

async function category(name: string, budgetAmount?: string) {
  return prisma.jobBudgetCategory.create({
    data: { jobId, name, sortOrder: 0, ...(budgetAmount ? { budgetAmount, budgetCurrency: 'GBP' } : {}) },
  })
}

async function costItem(opts: {
  categoryId?: string | null
  amount: string
  markPaid?: boolean
  memoryType?: string
  summary?: string
}) {
  const memoryType = opts.memoryType ?? 'ordered_material'
  const body: Record<string, unknown> = {
    memoryType,
    summary: opts.summary ?? `Cost ${opts.amount}`,
    costAmount: opts.amount,
    costCurrency: 'GBP',
    costQualifier: 'total',
    markPaid: opts.markPaid ?? false,
  }
  if (memoryType === 'ordered_material') body.materialName = 'OSB'
  if (memoryType === 'labour') Object.assign(body, { labourPerson: 'Dave', labourTask: 'Framing', labourHours: '8' })
  if (opts.categoryId !== undefined) body.budgetCategoryId = opts.categoryId
  const res = await post(memoryUrl(), body)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

// A memory item with real source evidence behind it: note -> transcript ->
// candidate fact -> review decision -> memory item.
async function itemWithSourceEvidence(categoryId: string, amount: string) {
  const note = await prisma.rawNote.create({
    data: {
      jobId,
      clientNoteId: randomUUID(),
      capturedAt: new Date('2026-08-01T08:00:00.000Z'),
      mimeType: 'audio/webm',
      sizeBytes: 100,
      serverStatus: 'TRANSCRIBED',
    },
  })
  const transcript = await prisma.transcript.create({
    data: { noteId: note.id, status: 'COMPLETED', text: 'Bought a load of timber for two hundred quid' },
  })
  const fact = await prisma.candidateFact.create({
    data: {
      jobId,
      sourceNoteId: note.id,
      sourceTranscriptId: transcript.id,
      factType: 'ORDERED_MATERIAL',
      summary: 'Bought timber',
      confidenceLabel: 'HIGH',
      confidenceReason: 'clear statement',
      uncertaintyFlags: [],
    },
  })
  const decision = await prisma.reviewDecision.create({
    data: { jobId, candidateFactId: fact.id, action: 'CONFIRM', decidedBy: ownerId },
  })
  const item = await prisma.memoryItem.create({
    data: {
      jobId,
      sourceCandidateFactId: fact.id,
      reviewDecisionId: decision.id,
      memoryType: 'ORDERED_MATERIAL',
      summary: 'Bought timber',
      materialName: 'Timber',
      costAmount: amount,
      costCurrency: 'GBP',
      costQualifier: 'total',
      totalCostAmount: amount,
      budgetCategoryId: categoryId,
      unresolvedFlags: [],
    },
  })
  return { item, note, transcript, fact, decision }
}

function categoryEntry(summary: any, categoryId: string) {
  return summary.categories.find((entry: any) => entry.category.id === categoryId)
}
function rowIds(entry: { rows: { memoryItemId: string }[] }) {
  return entry.rows.map((r) => r.memoryItemId)
}
function moneyRowFor(money: any, memoryItemId: string) {
  return money.rows.find((row: any) => row.sourceMemoryItemId === memoryItemId)
}

describe('PATCH budgetCategoryId — moving a cost item between categories', () => {
  it('moves the row A -> B, updates both categories, and leaves the job total alone', async () => {
    const timber = await category('Timber', '500')
    const electrics = await category('Electrics', '500')
    const moved = await costItem({ categoryId: timber.id, amount: '200' })
    // A second item stays put, so we can see the old category keep its remainder.
    const stays = await costItem({ categoryId: timber.id, amount: '50' })

    const before = (await get(budgetUrl())).json()
    expect(categoryEntry(before, timber.id)).toMatchObject({ knownSpendAmount: '250', remainingAmount: '250', overBudget: false })
    expect(categoryEntry(before, electrics.id)).toMatchObject({ knownSpendAmount: null, remainingAmount: '500' })

    const res = await patch(`${memoryUrl()}/${moved.id}`, { budgetCategoryId: electrics.id })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: moved.id, budgetCategoryId: electrics.id })

    const after = (await get(budgetUrl())).json()
    expect(rowIds(categoryEntry(after, timber.id))).toEqual([stays.id])
    expect(rowIds(categoryEntry(after, electrics.id))).toEqual([moved.id])
    expect(categoryEntry(after, timber.id)).toMatchObject({ knownSpendAmount: '50', remainingAmount: '450', overBudget: false })
    expect(categoryEntry(after, electrics.id)).toMatchObject({ knownSpendAmount: '200', remainingAmount: '300', overBudget: false })
    // Redistributing known cost never changes what the job has spent.
    expect(after.totals.knownSpendAmount).toBe(before.totals.knownSpendAmount)
    expect(after.totals.netKnownSpendAmount).toBe(before.totals.netKnownSpendAmount)
    expect(after.totals.notPaidAmount).toBe(before.totals.notPaidAmount)
  })

  it('moves the row to uncategorised on null and back to a category again', async () => {
    const timber = await category('Timber')
    const item = await costItem({ categoryId: timber.id, amount: '120' })

    const before = (await get(budgetUrl())).json()
    expect(before.uncategorized.rows).toEqual([])

    expect((await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: null })).statusCode).toBe(200)
    let after = (await get(budgetUrl())).json()
    expect(rowIds(categoryEntry(after, timber.id))).toEqual([])
    expect(categoryEntry(after, timber.id).knownSpendAmount).toBeNull()
    expect(rowIds(after.uncategorized)).toEqual([item.id])
    expect(after.uncategorized.knownSpendAmount).toBe('120')
    expect(after.totals.knownSpendAmount).toBe(before.totals.knownSpendAmount)

    // The correction is reversible: uncategorised back into a category.
    expect((await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: timber.id })).statusCode).toBe(200)
    after = (await get(budgetUrl())).json()
    expect(rowIds(categoryEntry(after, timber.id))).toEqual([item.id])
    expect(after.uncategorized.rows).toEqual([])
    expect(after.totals.knownSpendAmount).toBe(before.totals.knownSpendAmount)
  })

  it('omitting budgetCategoryId preserves the current assignment', async () => {
    const timber = await category('Timber')
    const item = await costItem({ categoryId: timber.id, amount: '75' })

    const res = await patch(`${memoryUrl()}/${item.id}`, { labourPersonId: null })
    expect(res.statusCode).toBe(200)
    expect(res.json().budgetCategoryId).toBe(timber.id)
    expect(rowIds(categoryEntry((await get(budgetUrl())).json(), timber.id))).toEqual([item.id])
  })

  it('reassigns labour and budget-cost items too', async () => {
    const first = await category('First')
    const second = await category('Second')
    const labour = await costItem({ categoryId: first.id, amount: '300', memoryType: 'labour', summary: 'Dave framing' })
    const budgetCost = await costItem({ categoryId: first.id, amount: '90', memoryType: 'budget_cost', summary: 'Skip hire' })

    expect((await patch(`${memoryUrl()}/${labour.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)
    expect((await patch(`${memoryUrl()}/${budgetCost.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)

    const after = (await get(budgetUrl())).json()
    expect(rowIds(categoryEntry(after, first.id))).toEqual([])
    expect(rowIds(categoryEntry(after, second.id)).sort()).toEqual([labour.id, budgetCost.id].sort())
    expect(categoryEntry(after, second.id).knownSpendAmount).toBe('390')
  })
})

describe('PATCH budgetCategoryId — payment state and Money', () => {
  it('carries paid state to the new category without touching the Money event', async () => {
    const first = await category('First')
    const second = await category('Second')
    const paid = await costItem({ categoryId: first.id, amount: '140', markPaid: true })
    const unpaid = await costItem({ categoryId: second.id, amount: '60' })

    const beforeBudget = (await get(budgetUrl())).json()
    const beforeMoney = (await get(moneyUrl())).json()
    const beforeEvent = moneyRowFor(beforeMoney, paid.id)
    expect(beforeEvent).toMatchObject({ kind: 'cost_paid', amount: '140', sourceBudgetCategoryId: first.id, sourceBudgetCategoryName: 'First' })
    expect(categoryEntry(beforeBudget, first.id)).toMatchObject({ paymentState: 'paid', paidAmount: '140', notPaidAmount: null })
    expect(categoryEntry(beforeBudget, second.id)).toMatchObject({ paymentState: 'not_paid', paidAmount: null, notPaidAmount: '60' })

    expect((await patch(`${memoryUrl()}/${paid.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)

    const afterBudget = (await get(budgetUrl())).json()
    // Old category has no eligible items left; new category is now mixed.
    expect(categoryEntry(afterBudget, first.id)).toMatchObject({ knownSpendAmount: null, paymentState: null, paymentStateReason: 'no_eligible_items' })
    expect(categoryEntry(afterBudget, second.id)).toMatchObject({
      knownSpendAmount: '200', paymentState: 'some_paid', paidAmount: '140', notPaidAmount: '60',
    })
    // Paid state itself did not change, so neither did the job-level figures.
    expect(afterBudget.totals.knownSpendAmount).toBe(beforeBudget.totals.knownSpendAmount)
    expect(afterBudget.totals.notPaidAmount).toBe(beforeBudget.totals.notPaidAmount)
    expect(afterBudget.totals.allKnownCostsPaid).toBe(beforeBudget.totals.allKnownCostsPaid)

    const afterMoney = (await get(moneyUrl())).json()
    const afterEvent = moneyRowFor(afterMoney, paid.id)
    // Same event, same amount, same link — only the category context follows.
    expect(afterEvent).toMatchObject({
      id: beforeEvent.id, kind: 'cost_paid', amount: '140',
      sourceMemoryItemId: paid.id, sourceBudgetCategoryId: second.id, sourceBudgetCategoryName: 'Second',
    })
    expect(afterEvent.occurredAt).toBe(beforeEvent.occurredAt)
    expect(afterMoney.rows).toHaveLength(beforeMoney.rows.length)
    expect(afterMoney.moneyOutAmount).toBe(beforeMoney.moneyOutAmount)
    // No duplicate COST_PAID row was written for this item.
    expect(await prisma.jobMoneyEvent.count({ where: { jobId, sourceMemoryItemId: paid.id, kind: 'COST_PAID', isDeleted: false } })).toBe(1)
    expect(await prisma.jobMoneyEvent.count({ where: { jobId } })).toBe(1)
  })

  it('clears a paid item to uncategorised without creating or dropping a Money event', async () => {
    const cat = await category('Structure')
    const paid = await costItem({ categoryId: cat.id, amount: '95', markPaid: true })
    const beforeMoney = (await get(moneyUrl())).json()
    const beforeEvent = moneyRowFor(beforeMoney, paid.id)

    expect((await patch(`${memoryUrl()}/${paid.id}`, { budgetCategoryId: null })).statusCode).toBe(200)

    const afterBudget = (await get(budgetUrl())).json()
    expect(rowIds(afterBudget.uncategorized)).toEqual([paid.id])
    expect(afterBudget.uncategorized.rows[0]).toMatchObject({ paymentState: 'paid', paidMoneyEventId: beforeEvent.id })
    expect(afterBudget.totals.notPaidAmount).toBe('0')
    expect(afterBudget.totals.allKnownCostsPaid).toBe(true)

    const afterEvent = moneyRowFor((await get(moneyUrl())).json(), paid.id)
    expect(afterEvent).toMatchObject({ id: beforeEvent.id, amount: '95', sourceBudgetCategoryId: null, sourceBudgetCategoryName: null })
    expect(await prisma.jobMoneyEvent.count({ where: { jobId } })).toBe(1)
  })

  it('leaves Mark paid / Undo paid working normally after a reassignment', async () => {
    const first = await category('First')
    const second = await category('Second')
    const item = await costItem({ categoryId: first.id, amount: '210', markPaid: true })
    expect((await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)

    const event = moneyRowFor((await get(moneyUrl())).json(), item.id)
    expect((await del(`/api/jobs/${jobId}/money/events/${event.id}`)).statusCode).toBe(204)

    const afterUndo = (await get(budgetUrl())).json()
    expect(categoryEntry(afterUndo, second.id)).toMatchObject({ knownSpendAmount: '210', paymentState: 'not_paid', notPaidAmount: '210' })
    expect(categoryEntry(afterUndo, second.id).rows[0]).toMatchObject({ memoryItemId: item.id, paidMoneyEventId: null, paidAt: null })
  })
})

describe('PATCH budgetCategoryId — invariants', () => {
  it('preserves item id, cost, description, date, and source evidence', async () => {
    const first = await category('First')
    const second = await category('Second')
    const { item, note, transcript, fact, decision } = await itemWithSourceEvidence(first.id, '200')

    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: second.id })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body).toMatchObject({
      id: item.id,
      memoryType: 'ordered_material',
      summary: 'Bought timber',
      materialName: 'Timber',
      costAmount: '200',
      costCurrency: 'GBP',
      costQualifier: 'total',
      totalCostAmount: '200',
      budgetCategoryId: second.id,
      sourceCandidateFactId: fact.id,
      reviewDecisionId: decision.id,
    })
    expect(body.source).toMatchObject({
      candidateFactId: fact.id,
      noteId: note.id,
      transcriptId: transcript.id,
      transcriptText: 'Bought a load of timber for two hundred quid',
    })

    // The existing row was updated in place — no copy, no new item.
    expect(await prisma.memoryItem.count({ where: { jobId } })).toBe(1)
    const row = await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } })
    expect(row).toMatchObject({
      budgetCategoryId: second.id,
      totalCostAmount: '200',
      summary: 'Bought timber',
      sourceCandidateFactId: fact.id,
      reviewDecisionId: decision.id,
      isRemoved: false,
      createdAt: item.createdAt,
    })
    // Source evidence itself is untouched.
    expect(await prisma.candidateFact.count({ where: { jobId } })).toBe(1)
    expect(await prisma.rawNote.count({ where: { jobId } })).toBe(1)
    expect(await prisma.transcript.count({ where: { noteId: note.id } })).toBe(1)
  })

  it('keeps the item visible in memory-view with its source after the move', async () => {
    const first = await category('First')
    const second = await category('Second')
    const { item, fact } = await itemWithSourceEvidence(first.id, '80')

    expect((await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)

    const view = (await get(`/api/jobs/${jobId}/memory-view`)).json()
    const found = view.sections
      .flatMap((section: any) => section.items ?? [])
      .find((entry: any) => entry.id === item.id)
    expect(found).toBeTruthy()
    expect(found.budgetCategoryId).toBe(second.id)
    expect(found.sourceCandidateFactId).toBe(fact.id)
  })
})

// The frontend decides whether to show the category selector from this flag
// rather than hard-coding a type list that would go stale (budget_cost was
// added to the assignable set after ordered_material and labour).
describe('canAssignBudgetCategory eligibility flag', () => {
  it('is true for the assignable cost types and false for the rest', async () => {
    const cat = await category('Timber')
    const assignable = [
      (await costItem({ categoryId: cat.id, amount: '10', memoryType: 'ordered_material' })).id,
      (await costItem({ categoryId: cat.id, amount: '20', memoryType: 'labour', summary: 'Dave' })).id,
      (await costItem({ categoryId: cat.id, amount: '30', memoryType: 'budget_cost', summary: 'Skip' })).id,
    ]
    const notAssignable: string[] = []
    for (const memoryType of ['used_material', 'leftover_material', 'general_note', 'watch_out']) {
      const res = await post(memoryUrl(), { memoryType, summary: `A ${memoryType}` })
      expect(res.statusCode, memoryType).toBe(201)
      expect(res.json(), memoryType).toMatchObject({ canAssignBudgetCategory: false })
      notAssignable.push(res.json().id)
    }

    const view = (await get(`/api/jobs/${jobId}/memory-view`)).json()
    const flagById = new Map<string, boolean>(
      view.sections
        .flatMap((section: any) => section.items ?? [])
        .map((entry: any) => [entry.id, entry.canAssignBudgetCategory]),
    )
    for (const id of assignable) expect(flagById.get(id), id).toBe(true)
    for (const id of notAssignable) expect(flagById.get(id), id).toBe(false)
  })

  it('follows a memory type change on the PATCH response', async () => {
    const cat = await category('Timber')
    const item = await costItem({ categoryId: cat.id, amount: '40' })
    const res = await patch(`${memoryUrl()}/${item.id}`, { memoryType: 'used_material', summary: 'Used the timber' })
    expect(res.statusCode).toBe(200)
    // Type changed away from an assignable type: the flag and the category both go.
    expect(res.json()).toMatchObject({ canAssignBudgetCategory: false, budgetCategoryId: null })
  })
})

describe('PATCH budgetCategoryId — rejections', () => {
  it('rejects a category belonging to another job with 404', async () => {
    const mine = await category('Mine')
    const item = await costItem({ categoryId: mine.id, amount: '30' })
    const otherJob = await prisma.job.create({ data: { ownerUserId: otherOwnerId, title: 'Other job', jobType: 'garden_room' } })
    const foreign = await prisma.jobBudgetCategory.create({ data: { jobId: otherJob.id, name: 'Foreign', sortOrder: 0 } })

    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: foreign.id })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('BUDGET_CATEGORY_NOT_FOUND')
    // unchanged
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } })).budgetCategoryId).toBe(mine.id)
  })

  it('rejects an unknown category with 404', async () => {
    const mine = await category('Mine')
    const item = await costItem({ categoryId: mine.id, amount: '30' })
    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: randomUUID() })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('BUDGET_CATEGORY_NOT_FOUND')
  })

  it('rejects an archived category with 400', async () => {
    const mine = await category('Mine')
    const retired = await category('Retired')
    const item = await costItem({ categoryId: mine.id, amount: '30' })
    await prisma.jobBudgetCategory.update({ where: { id: retired.id }, data: { isArchived: true } })

    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: retired.id })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BUDGET_CATEGORY_ARCHIVED')
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } })).budgetCategoryId).toBe(mine.id)
  })

  it('rejects a category on a non-category-assignable memory type with 400', async () => {
    const cat = await category('Timber')
    const leftover = await post(memoryUrl(), {
      memoryType: 'leftover_material', summary: 'Half a box of screws', materialName: 'Screws', quantity: '0.5', unit: 'box',
    })
    expect(leftover.statusCode).toBe(201)

    const res = await patch(`${memoryUrl()}/${leftover.json().id}`, { budgetCategoryId: cat.id })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: leftover.json().id } })).budgetCategoryId).toBeNull()
  })

  it('rejects reassigning a removed item with 404', async () => {
    const first = await category('First')
    const second = await category('Second')
    const item = await costItem({ categoryId: first.id, amount: '45' })
    expect((await del(`${memoryUrl()}/${item.id}`)).statusCode).toBe(204)

    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: second.id })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('MEMORY_ITEM_NOT_FOUND')
  })

  it('rejects reassignment by a non-owner with 403', async () => {
    const first = await category('First')
    const second = await category('Second')
    const item = await costItem({ categoryId: first.id, amount: '45' })

    const res = await app.inject({
      method: 'PATCH',
      url: `${memoryUrl()}/${item.id}`,
      headers: { 'x-pilot-user-id': otherOwnerId, 'content-type': 'application/json' },
      payload: { budgetCategoryId: second.id },
    })
    expect(res.statusCode).toBe(403)
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } })).budgetCategoryId).toBe(first.id)
  })

  it('rejects a malformed budgetCategoryId with 400 and leaves the item alone', async () => {
    const first = await category('First')
    const item = await costItem({ categoryId: first.id, amount: '45' })
    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: 42 })
    expect(res.statusCode).toBe(400)
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: item.id } })).budgetCategoryId).toBe(first.id)
  })
})

describe('PATCH budgetCategoryId — item sitting on a no-longer-active category', () => {
  // Archiving a category already clears its items to Uncategorised, so this
  // state is not reachable through the API. A directly-seeded row proves Fix
  // memory can still rescue one if it ever occurs.
  async function itemOnArchivedCategory() {
    const retired = await category('Retired')
    const item = await costItem({ categoryId: retired.id, amount: '65' })
    await prisma.jobBudgetCategory.update({ where: { id: retired.id }, data: { isArchived: true } })
    await prisma.memoryItem.update({ where: { id: item.id }, data: { budgetCategoryId: retired.id } })
    return { retired, item }
  }

  it('still allows moving it to an active category', async () => {
    const active = await category('Active')
    const { item } = await itemOnArchivedCategory()

    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: active.id })
    expect(res.statusCode).toBe(200)
    expect(res.json().budgetCategoryId).toBe(active.id)
    expect(rowIds(categoryEntry((await get(budgetUrl())).json(), active.id))).toEqual([item.id])
  })

  it('still allows clearing it to uncategorised', async () => {
    const { item } = await itemOnArchivedCategory()
    const res = await patch(`${memoryUrl()}/${item.id}`, { budgetCategoryId: null })
    expect(res.statusCode).toBe(200)
    expect(res.json().budgetCategoryId).toBeNull()
    expect(rowIds((await get(budgetUrl())).json().uncategorized)).toEqual([item.id])
  })

  it('archiving a category moves its items to uncategorised without changing the job total', async () => {
    const retired = await category('Retired')
    const item = await costItem({ categoryId: retired.id, amount: '65' })
    const before = (await get(budgetUrl())).json()

    expect((await patch(`/api/jobs/${jobId}/budget-categories/${retired.id}`, { isArchived: true })).statusCode).toBe(200)

    const after = (await get(budgetUrl())).json()
    expect(rowIds(after.uncategorized)).toEqual([item.id])
    expect(after.totals.knownSpendAmount).toBe(before.totals.knownSpendAmount)
  })
})
