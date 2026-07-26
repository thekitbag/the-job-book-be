// Money In/Out: unified read model, mark-paid (Money out), refund projection,
// and event removal. Mocked-prisma style (matches payments.http.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'money-user-1'
const OTHER_USER_ID = 'money-user-2'
const JOB_ID = 'money-job-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    jobPayment: { findMany: vi.fn() },
    jobMoneyEvent: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    memoryItem: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}))

function makeUser(overrides?: object) {
  return { id: USER_ID, email: 'p@t.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makeJob(overrides?: object) {
  return {
    id: JOB_ID, ownerUserId: USER_ID, title: 'Garden room', jobType: 'garden_room', status: 'STARTED',
    roughLocationOrLabel: null, notes: null, customerTotalAmount: null as string | null,
    customerTotalCurrency: null as string | null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  }
}
function makePayment(overrides?: object) {
  return {
    id: 'pay-1', jobId: JOB_ID, amount: '1500', currency: 'GBP',
    paidAt: new Date('2026-07-10T11:00:00.000Z'), note: 'deposit', reference: null,
    isDeleted: false, deletedAt: null,
    createdAt: new Date('2026-07-10T12:00:00.000Z'), updatedAt: new Date('2026-07-10T12:00:00.000Z'), ...overrides,
  }
}
function makeEvent(overrides?: object) {
  return {
    id: 'evt-1', jobId: JOB_ID, direction: 'OUT', kind: 'COST_PAID', amount: '280', currency: 'GBP',
    occurredAt: new Date('2026-07-20T11:00:00.000Z'), note: null, reference: null,
    sourceMemoryItemId: 'mem-mat', isDeleted: false, deletedAt: null,
    createdAt: new Date('2026-07-20T12:00:00.000Z'), updatedAt: new Date('2026-07-20T12:00:00.000Z'), ...overrides,
  }
}
// A memory item shaped for classifySpend (trusted material by default).
function makeMemItem(overrides?: object) {
  return {
    id: 'mem-mat', jobId: JOB_ID, memoryType: 'ORDERED_MATERIAL', isManual: false, summary: 'Ordered timber',
    materialName: 'timber', quantity: '1', unit: 'load', supplierName: null, deliveryTiming: null, locationOrUse: null,
    costAmount: null, costCurrency: 'GBP', costQualifier: null, totalCostAmount: '280',
    labourHours: null, labourPerson: null, labourTask: null, happenedAt: null,
    unresolvedFlags: [] as string[], budgetCategoryId: null, isRemoved: false,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  }
}

let app: FastifyInstance
beforeAll(async () => {
  app = buildApp({ storage: new FakeAudioStorage(), transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(async () => {
  vi.clearAllMocks()
  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([])
  vi.mocked((prisma as any).jobMoneyEvent.findMany).mockResolvedValue([])
  vi.mocked((prisma as any).jobMoneyEvent.findFirst).mockResolvedValue(null)
  vi.mocked((prisma as any).jobMoneyEvent.create).mockImplementation(async ({ data }: any) => ({ id: 'evt-new', createdAt: new Date(), updatedAt: new Date(), ...data }))
  vi.mocked((prisma as any).jobMoneyEvent.update).mockResolvedValue({})
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
})

const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const MONEY_URL = `/api/jobs/${JOB_ID}/money`

describe('GET /api/jobs/:jobId/money', () => {
  it('returns an empty summary with null totals when there is no money movement', async () => {
    const res = await app.inject({ method: 'GET', url: MONEY_URL, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      jobId: JOB_ID, moneyInAmount: null, moneyOutAmount: null,
      stillOwedAmount: null, overpaid: false, rows: [],
    })
  })

  it('projects customer payments as Money in and money events as in/out, newest first', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ customerTotalAmount: '4000', customerTotalCurrency: 'GBP' }))
    vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([makePayment({ id: 'pay-1', amount: '1500' })])
    vi.mocked((prisma as any).jobMoneyEvent.findMany).mockResolvedValue([
      makeEvent({ id: 'evt-out', kind: 'COST_PAID', direction: 'OUT', amount: '280', sourceMemoryItemId: 'mem-mat', occurredAt: new Date('2026-07-20T11:00:00.000Z') }),
      makeEvent({ id: 'evt-in', kind: 'REFUND', direction: 'IN', amount: '80', sourceMemoryItemId: 'mem-ret', occurredAt: new Date('2026-07-22T11:00:00.000Z') }),
    ])
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      { id: 'mem-mat', materialName: 'timber', labourTask: null, summary: 'Ordered timber', memoryType: 'ORDERED_MATERIAL' },
      { id: 'mem-ret', materialName: 'OSB', labourTask: null, summary: 'Returned OSB', memoryType: 'RETURNED_MATERIAL' },
    ])
    const body = (await app.inject({ method: 'GET', url: MONEY_URL, headers })).json()

    // in = 1500 payment + 80 refund; out = 280 cost paid
    expect(body.moneyInAmount).toBe('1580')
    expect(body.moneyInLabel).toBe('£1580 received')
    expect(body.moneyOutAmount).toBe('280')
    expect(body.moneyOutLabel).toBe('£280 paid out')
    // still owed uses customer payments only (refund does not reduce it)
    expect(body.stillOwedAmount).toBe('2500')

    // newest first by occurredAt: refund (22nd), cost paid (20th), payment (10th)
    expect(body.rows.map((r: any) => r.id)).toEqual(['evt-in', 'evt-out', 'pay-1'])
    const refund = body.rows.find((r: any) => r.id === 'evt-in')
    expect(refund).toMatchObject({ direction: 'in', kind: 'refund', amountLabel: '+£80', sourceItemLabel: 'OSB', sourceMemoryType: 'returned_material', editable: false, removable: true })
    const costPaid = body.rows.find((r: any) => r.id === 'evt-out')
    expect(costPaid).toMatchObject({ direction: 'out', kind: 'cost_paid', amountLabel: '-£280', sourceItemLabel: 'timber' })
    const payment = body.rows.find((r: any) => r.id === 'pay-1')
    expect(payment).toMatchObject({ direction: 'in', kind: 'customer_payment', editable: true, sourceMemoryItemId: null })
  })

  it('enforces ownership and auth', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'GET', url: MONEY_URL, headers })).statusCode).toBe(403)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'GET', url: MONEY_URL, headers: { 'x-pilot-user-id': 'ghost' } })).statusCode).toBe(401)
  })
})

describe('POST /api/jobs/:jobId/money/out — mark paid', () => {
  const OUT_URL = `/api/jobs/${JOB_ID}/money/out`

  it('creates a Money out event from a trusted material line total, without touching the source item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemItem({ id: 'mem-mat', totalCostAmount: '280' }))
    const res = await app.inject({ method: 'POST', url: OUT_URL, headers, payload: { sourceMemoryItemId: 'mem-mat' } })
    expect(res.statusCode).toBe(200)
    const created = vi.mocked((prisma as any).jobMoneyEvent.create).mock.calls[0][0].data
    expect(created).toMatchObject({ direction: 'OUT', kind: 'COST_PAID', amount: '280', currency: 'GBP', sourceMemoryItemId: 'mem-mat' })
    // amount is derived, never mutates the source memory item
    expect(prisma.memoryItem.update).not.toHaveBeenCalled()
  })

  it('creates a Money out event from a trusted labour cost total', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemItem({
      id: 'mem-lab', memoryType: 'LABOUR', materialName: null, labourTask: 'electrics', labourHours: '8',
      costAmount: '35', costQualifier: 'per_hour', totalCostAmount: '280', costCurrency: 'GBP', labourBudgetEnabled: true,
    }))
    const res = await app.inject({ method: 'POST', url: OUT_URL, headers, payload: { sourceMemoryItemId: 'mem-lab' } })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked((prisma as any).jobMoneyEvent.create).mock.calls[0][0].data.amount).toBe('280')
  })

  it('rejects a duplicate mark-paid with MONEY_EVENT_ALREADY_EXISTS', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemItem())
    vi.mocked((prisma as any).jobMoneyEvent.findFirst).mockResolvedValue(makeEvent())
    const res = await app.inject({ method: 'POST', url: OUT_URL, headers, payload: { sourceMemoryItemId: 'mem-mat' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MONEY_EVENT_ALREADY_EXISTS')
    expect((prisma as any).jobMoneyEvent.create).not.toHaveBeenCalled()
  })

  it('requires sourceMemoryItemId and 404s an unknown item', async () => {
    const { prisma } = await import('../src/db/client.js')
    expect((await app.inject({ method: 'POST', url: OUT_URL, headers, payload: {} })).statusCode).toBe(400)
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'POST', url: OUT_URL, headers, payload: { sourceMemoryItemId: 'nope' } })
    expect(res.statusCode).toBe(404)
  })

  const ineligible: Array<[string, object]> = [
    ['missing-price material', { totalCostAmount: null, costAmount: null }],
    ['unresolved-flag item', { unresolvedFlags: ['cost_uncertain'] }],
    ['non-GBP total', { costCurrency: 'EUR' }],
    ['used material', { memoryType: 'USED_MATERIAL' }],
    ['leftover material', { memoryType: 'LEFTOVER_MATERIAL' }],
    ['returned material', { memoryType: 'RETURNED_MATERIAL' }],
    ['general note', { memoryType: 'GENERAL_NOTE', totalCostAmount: null }],
  ]
  it.each(ineligible)('rejects an ineligible source: %s', async (_name, override) => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemItem(override))
    const res = await app.inject({ method: 'POST', url: OUT_URL, headers, payload: { sourceMemoryItemId: 'mem-mat' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    expect((prisma as any).jobMoneyEvent.create).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/jobs/:jobId/money/events/:moneyEventId', () => {
  it('soft-deletes an active money event (Money-only correction)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobMoneyEvent.findFirst).mockResolvedValue(makeEvent())
    const res = await app.inject({ method: 'DELETE', url: `${MONEY_URL}/events/evt-1`, headers: { 'x-pilot-user-id': USER_ID } })
    expect(res.statusCode).toBe(204)
    const data = vi.mocked((prisma as any).jobMoneyEvent.update).mock.calls[0][0]
    expect(data.where).toEqual({ id: 'evt-1' })
    expect(data.data.isDeleted).toBe(true)
    // deleting a Money out marker must not touch the source memory item
    expect(prisma.memoryItem.update).not.toHaveBeenCalled()
  })

  it('404s an unknown/deleted/cross-job event', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobMoneyEvent.findFirst).mockResolvedValue(null)
    const res = await app.inject({ method: 'DELETE', url: `${MONEY_URL}/events/ghost`, headers: { 'x-pilot-user-id': USER_ID } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('MONEY_EVENT_NOT_FOUND')
  })
})
