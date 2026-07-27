// Real-DB end-to-end for the hours/Budget/Money split:
//   · Labour records time (hours only, never cost in Budget/Money);
//   · Budget records job cost (BUDGET_COST, trusted GBP total counts toward Budget
//     regardless of paid state; legacy budget-enabled LABOUR cost still counts once);
//   · Money records actual movement (mark paid → one COST_PAID out; undo paid
//     removes it and leaves Budget unchanged; a removed source leaves no orphan).
// Uses the X-Pilot-User-Id header auth against real Postgres (no mocks) so the
// service, spend classifier, Budget aggregation, and Money model are exercised
// together the way the frontend consumes them.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'labour-budget-costs-'

let app: FastifyInstance
let ownerId: string
let otherId: string
let jobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: ids } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.labourPerson.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  const owner = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Owner', role: 'PILOT' } })
  const other = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}other@test.local`, name: 'Other', role: 'PILOT' } })
  ownerId = owner.id
  otherId = other.id
})

afterAll(async () => {
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  const job = await prisma.job.create({ data: { ownerUserId: ownerId, title: 'Costs job', jobType: 'garden_room' } })
  jobId = job.id
})

function ownerHeaders() {
  return { 'x-pilot-user-id': ownerId }
}
function otherHeaders() {
  return { 'x-pilot-user-id': otherId }
}
const jsonHeaders = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' })

function post(url: string, body: object, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url, headers: jsonHeaders(headers), payload: body })
}
function get(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url, headers })
}
function del(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'DELETE', url, headers })
}

const memUrl = () => `/api/jobs/${jobId}/memory-items`
const budgetUrl = () => `/api/jobs/${jobId}/budget-summary`
const moneyUrl = () => `/api/jobs/${jobId}/money`
const moneyOutUrl = () => `/api/jobs/${jobId}/money/out`
const memViewUrl = () => `/api/jobs/${jobId}/memory-view`
const peopleUrl = (id = jobId) => `/api/jobs/${id}/labour-people`

// A trusted GBP budget cost (£120 total).
function budgetCostBody(overrides: object = {}) {
  return {
    memoryType: 'budget_cost',
    summary: 'Kurt — fitting cladding',
    labourPerson: 'Kurt',
    labourTask: 'fitting cladding',
    costAmount: '120',
    costCurrency: 'GBP',
    costQualifier: 'total',
    ...overrides,
  }
}

describe('Budget cost: normalization and inclusion', () => {
  it('a trusted GBP budget_cost counts toward Budget once, with no hours', async () => {
    const created = await post(memUrl(), budgetCostBody(), ownerHeaders())
    expect(created.statusCode).toBe(201)
    const item = created.json()
    expect(item.memoryType).toBe('budget_cost')
    expect(item.totalCostAmount).toBe('120')
    expect(item.labourHours).toBeNull()

    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBe('120')
    // Counted exactly once across uncategorized + category rows.
    const allRows = [...budget.uncategorized.rows, ...budget.categories.flatMap((c: any) => c.rows)]
    const mine = allRows.filter((r: any) => r.memoryItemId === item.id)
    expect(mine).toHaveLength(1)
  })

  it('an ambiguous budget_cost (no safe total) is excluded from Budget as worth checking', async () => {
    const created = await post(memUrl(), budgetCostBody({ costQualifier: 'unknown' }), ownerHeaders())
    expect(created.statusCode).toBe(201)
    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBeNull()
  })
})

describe('Labour owns hours and committed cost', () => {
  it('keeps people and default rates local to a job', async () => {
    const kurt = await post(peopleUrl(), { name: 'Kurt', defaultHourlyRateAmount: '20', defaultHourlyRateCurrency: 'GBP' }, ownerHeaders())
    expect(kurt.statusCode).toBe(201)
    const otherJob = await prisma.job.create({ data: { ownerUserId: ownerId, title: 'Other job', jobType: 'garden_room' } })
    expect((await get(peopleUrl(otherJob.id), ownerHeaders())).json().people).toHaveLength(0)
    const otherKurt = await post(peopleUrl(otherJob.id), { name: 'Kurt', defaultHourlyRateAmount: '30', defaultHourlyRateCurrency: 'GBP' }, ownerHeaders())
    expect(otherKurt.statusCode).toBe(201)
    const entry = await post(memUrl(), { memoryType: 'labour', summary: 'Kurt roofing', labourPersonId: kurt.json().id, labourHours: '8' }, ownerHeaders())
    expect(entry.statusCode).toBe(201)
    expect(entry.json().totalCostAmount).toBe('160')
    expect((await post(memUrl(), { memoryType: 'labour', summary: 'Wrong job', labourPersonId: otherKurt.json().id, labourHours: '1' }, ownerHeaders())).statusCode).toBe(404)
  })
  it('a labour entry with hours only never enters Budget or Money', async () => {
    const created = await post(
      memUrl(),
      { memoryType: 'labour', summary: 'Sam framing', labourPerson: 'Sam', labourTask: 'framing', labourHours: '5' },
      ownerHeaders(),
    )
    expect(created.statusCode).toBe(201)

    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBeNull()

    const view = (await get(memViewUrl(), ownerHeaders())).json()
    expect(view.labourHoursSummary.totalHours).toBe('5')

    const money = (await get(moneyUrl(), ownerHeaders())).json()
    expect(money.moneyOutAmount).toBeNull()
  })

  it('a trusted positive labour rate counts toward Budget without a Budget treatment flag', async () => {
    const created = await post(
      memUrl(),
      {
        memoryType: 'labour', summary: 'Tom electrics', labourPerson: 'Tom', labourTask: 'electrics',
        labourHours: '8', costAmount: '35', costCurrency: 'GBP', costQualifier: 'per_hour',
      },
      ownerHeaders(),
    )
    expect(created.statusCode).toBe(201)
    const item = created.json()
    expect(item.totalCostAmount).toBe('280') // 8 × 35

    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBe('280')
    const labourRows = budget.labour.rows.filter((r: any) => r.memoryItemId === item.id)
    expect(labourRows).toHaveLength(1)
  })

  it('£0 labour keeps hours but is neither Budget cost nor payable', async () => {
    const created = await post(memUrl(), { memoryType: 'labour', summary: 'Me clearing up', labourHours: '6', costAmount: '0', costCurrency: 'GBP', costQualifier: 'per_hour' }, ownerHeaders())
    expect(created.statusCode).toBe(201)
    expect((await get(budgetUrl(), ownerHeaders())).json().totals.knownSpendAmount).toBeNull()
    expect((await post(moneyOutUrl(), { sourceMemoryItemId: created.json().id }, ownerHeaders())).statusCode).toBe(400)
    expect((await get(memViewUrl(), ownerHeaders())).json().labourHoursSummary.totalHours).toBe('6')
  })

  it('fixed total labour without hours contributes Budget', async () => {
    const created = await post(memUrl(), { memoryType: 'labour', summary: 'Roof labour fixed price', labourTask: 'roof', costAmount: '600', costCurrency: 'GBP', costQualifier: 'total' }, ownerHeaders())
    expect(created.statusCode).toBe(201)
    expect(created.json().labourHours).toBeNull()
    expect((await get(budgetUrl(), ownerHeaders())).json().totals.knownSpendAmount).toBe('600')
  })
})

describe('Add cost as already paid (markPaid)', () => {
  it('creates the Budget cost and exactly one Money out when trusted', async () => {
    const created = await post(memUrl(), budgetCostBody({ markPaid: true }), ownerHeaders())
    expect(created.statusCode).toBe(201)
    const item = created.json()

    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBe('120') // paid state does not change Budget

    const money = (await get(moneyUrl(), ownerHeaders())).json()
    expect(money.moneyOutAmount).toBe('120')
    const outRows = money.rows.filter((r: any) => r.kind === 'cost_paid' && r.sourceMemoryItemId === item.id)
    expect(outRows).toHaveLength(1)
  })

  it('rejects markPaid on an untrusted cost and creates neither the cost nor a Money out', async () => {
    const res = await post(memUrl(), budgetCostBody({ costQualifier: 'unknown', markPaid: true }), ownerHeaders())
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')

    // Atomic: the whole create rolled back — no Budget row, no Money out.
    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBeNull()
    const money = (await get(moneyUrl(), ownerHeaders())).json()
    expect(money.moneyOutAmount).toBeNull()
  })
})

describe('Mark paid / undo paid cycle', () => {
  async function createUnpaidCost() {
    const res = await post(memUrl(), budgetCostBody(), ownerHeaders())
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }

  it('mark paid is idempotent under duplicate requests (one active Money out)', async () => {
    const id = await createUnpaidCost()
    const first = await post(moneyOutUrl(), { sourceMemoryItemId: id }, ownerHeaders())
    expect(first.statusCode).toBe(200)
    const second = await post(moneyOutUrl(), { sourceMemoryItemId: id }, ownerHeaders())
    expect(second.statusCode).toBe(400)
    expect(second.json().code).toBe('MONEY_EVENT_ALREADY_EXISTS')

    const money = (await get(moneyUrl(), ownerHeaders())).json()
    expect(money.rows.filter((r: any) => r.sourceMemoryItemId === id)).toHaveLength(1)
  })

  it('undo paid removes the Money out and leaves Budget unchanged; re-mark does not duplicate', async () => {
    const id = await createUnpaidCost()
    await post(moneyOutUrl(), { sourceMemoryItemId: id }, ownerHeaders())

    const budgetBefore = (await get(budgetUrl(), ownerHeaders())).json()
    const moneyPaid = (await get(moneyUrl(), ownerHeaders())).json()
    const eventId = moneyPaid.rows.find((r: any) => r.sourceMemoryItemId === id).id

    const undo = await del(`/api/jobs/${jobId}/money/events/${eventId}`, ownerHeaders())
    expect(undo.statusCode).toBe(204)

    const moneyAfter = (await get(moneyUrl(), ownerHeaders())).json()
    expect(moneyAfter.moneyOutAmount).toBeNull()
    const budgetAfter = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budgetAfter.totals.knownSpendAmount).toBe(budgetBefore.totals.knownSpendAmount)

    // Re-mark paid after undo works and stays single (previous event soft-deleted).
    const remark = await post(moneyOutUrl(), { sourceMemoryItemId: id }, ownerHeaders())
    expect(remark.statusCode).toBe(200)
    const moneyRemarked = (await get(moneyUrl(), ownerHeaders())).json()
    expect(moneyRemarked.rows.filter((r: any) => r.sourceMemoryItemId === id && r.kind === 'cost_paid')).toHaveLength(1)
  })

  it('removing the source Budget cost leaves no active orphan Money out', async () => {
    const created = await post(memUrl(), budgetCostBody({ markPaid: true }), ownerHeaders())
    const id = created.json().id

    const removed = await del(`${memUrl()}/${id}`, ownerHeaders())
    expect(removed.statusCode).toBe(204)

    const money = (await get(moneyUrl(), ownerHeaders())).json()
    expect(money.moneyOutAmount).toBeNull()
    expect(money.rows.filter((r: any) => r.sourceMemoryItemId === id)).toHaveLength(0)

    const budget = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budget.totals.knownSpendAmount).toBeNull()
  })
})

describe('Review/extraction keeps a coherent labour fact together', () => {
  async function seedLabourNote() {
    const note = await prisma.rawNote.create({
      data: { jobId, clientNoteId: randomUUID(), capturedAt: new Date(), mimeType: 'audio/webm', sizeBytes: 100, serverStatus: 'EXTRACTED' },
    })
    const transcript = await prisma.transcript.create({
      data: { noteId: note.id, status: 'COMPLETED', text: 'Tom did 8 hours on electrics and it came to £280' },
    })
    const base = { jobId, sourceNoteId: note.id, sourceTranscriptId: transcript.id, confidenceLabel: 'HIGH' as const, confidenceReason: 'stated', uncertaintyFlags: [] }
    await prisma.candidateFact.create({ data: { ...base, factType: 'LABOUR', summary: 'Tom did 8 hours on electrics', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics', costAmount: '35', costCurrency: 'GBP', costQualifier: 'per_hour', totalCostAmount: '280' } })
    return note.id
  }

  it('surfaces one labour outcome with both hours and cost', async () => {
    await seedLabourNote()

    const queue = (await get(`/api/jobs/${jobId}/review-queue`, ownerHeaders())).json()
    const labourSection = queue.sections.find((s: any) => s.key === 'labour')
    expect(labourSection.items).toHaveLength(1)
    const labourItem = labourSection.items[0]
    expect(labourItem.proposedMemory.memoryType).toBe('labour')
    expect(labourItem.proposedMemory.totalCostAmount).toBe('280')
    const confirmed = await post(
      `/api/jobs/${jobId}/review-queue-decisions`,
      { action: 'confirm', queueItemId: labourItem.id },
      ownerHeaders(),
    )
    expect(confirmed.statusCode).toBe(200)
    const budgetEnd = (await get(budgetUrl(), ownerHeaders())).json()
    expect(budgetEnd.totals.knownSpendAmount).toBe('280')
    const view = (await get(memViewUrl(), ownerHeaders())).json()
    expect(view.labourHoursSummary.totalHours).toBe('8')
  })
})

describe('Ownership boundaries', () => {
  it('a non-owner cannot add cost, mark paid, remove, or read Budget/Money', async () => {
    const created = await post(memUrl(), budgetCostBody({ markPaid: true }), ownerHeaders())
    const id = created.json().id

    expect((await post(memUrl(), budgetCostBody(), otherHeaders())).statusCode).toBe(403)
    expect((await post(moneyOutUrl(), { sourceMemoryItemId: id }, otherHeaders())).statusCode).toBe(403)
    expect((await del(`${memUrl()}/${id}`, otherHeaders())).statusCode).toBe(403)
    expect((await get(budgetUrl(), otherHeaders())).statusCode).toBe(403)
    expect((await get(moneyUrl(), otherHeaders())).statusCode).toBe(403)
  })
})
