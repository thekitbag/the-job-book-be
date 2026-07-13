// Customer payments: money-in memory. Owner-scoped summary/create/edit/
// soft-delete, GBP only, and hard separation from spend — payments must never
// touch budget or memory-view cost totals.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'pay-user-1'
const OTHER_USER_ID = 'pay-user-2'
const JOB_ID = 'pay-job-1'
const PAYMENT_ID = 'pay-payment-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn(), update: vi.fn() },
    jobPayment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    memoryItem: { findMany: vi.fn() },
    jobBudgetCategory: { findMany: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    queueItem: { findMany: vi.fn() },
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
    id: PAYMENT_ID, jobId: JOB_ID, amount: '1500', currency: 'GBP',
    paidAt: new Date('2026-07-10T11:00:00.000Z'), note: 'deposit', reference: null,
    isDeleted: false, deletedAt: null,
    createdAt: new Date('2026-07-10T12:00:00.000Z'), updatedAt: new Date('2026-07-10T12:00:00.000Z'),
    ...overrides,
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
  vi.mocked((prisma.job as any).update).mockImplementation(async ({ data }: any) => ({ ...makeJob(), ...data }))
  vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([])
  vi.mocked((prisma as any).jobPayment.findFirst).mockResolvedValue(null)
  vi.mocked((prisma as any).jobPayment.create).mockImplementation(async ({ data }: any) => ({ ...makePayment(), ...data, id: 'pay-new' }))
  vi.mocked((prisma as any).jobPayment.update).mockImplementation(async ({ data }: any) => ({ ...makePayment(), ...data }))
})

const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const URL_BASE = `/api/jobs/${JOB_ID}/payments`

describe('GET /api/jobs/:jobId/payments — summary', () => {
  it('returns an empty summary when there is no total and no payments', async () => {
    const res = await app.inject({ method: 'GET', url: URL_BASE, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      jobId: JOB_ID,
      customerTotalAmount: null, customerTotalCurrency: null, customerTotalLabel: null,
      totalPaidAmount: null, totalPaidCurrency: null, totalPaidLabel: null,
      stillOwedAmount: null, stillOwedCurrency: null, stillOwedLabel: null,
      overpaid: false, overpaidAmount: null, overpaidLabel: null,
      payments: [],
    })
  })

  it('sums active payments and computes still owed against the customer total', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ customerTotalAmount: '4200', customerTotalCurrency: 'GBP' }))
    vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([
      makePayment({ id: 'p2', amount: '1000', note: 'stage 1', paidAt: new Date('2026-07-12T11:00:00.000Z') }),
      makePayment({ id: 'p1', amount: '500', note: 'deposit', paidAt: new Date('2026-07-01T11:00:00.000Z') }),
    ])
    const res = await app.inject({ method: 'GET', url: URL_BASE, headers })
    const body = res.json()
    expect(body.customerTotalAmount).toBe('4200')
    expect(body.customerTotalLabel).toBe('£4200')
    expect(body.totalPaidAmount).toBe('1500')
    expect(body.totalPaidLabel).toBe('£1500 paid')
    expect(body.stillOwedAmount).toBe('2700')
    expect(body.stillOwedLabel).toBe('£2700 still owed')
    expect(body.overpaid).toBe(false)
    expect(body.payments.map((p: any) => p.id)).toEqual(['p2', 'p1'])
    expect(body.payments[0].amountLabel).toBe('£1000')
    // deleted payments are excluded at the query level
    const where = vi.mocked((prisma as any).jobPayment.findMany).mock.calls[0][0].where
    expect(where).toMatchObject({ jobId: JOB_ID, isDeleted: false })
  })

  it('reports payments with no customer total (still owed stays null)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([makePayment({ amount: '1500' })])
    const body = (await app.inject({ method: 'GET', url: URL_BASE, headers })).json()
    expect(body.totalPaidAmount).toBe('1500')
    expect(body.stillOwedAmount).toBeNull()
    expect(body.overpaid).toBe(false)
  })

  it('flags overpaid when paid exceeds the customer total', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ customerTotalAmount: '1000', customerTotalCurrency: 'GBP' }))
    vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([makePayment({ amount: '1250.50' })])
    const body = (await app.inject({ method: 'GET', url: URL_BASE, headers })).json()
    expect(body.overpaid).toBe(true)
    expect(body.stillOwedAmount).toBe('0')
    expect(body.overpaidAmount).toBe('250.5')
    expect(body.overpaidLabel).toBe('£250.5 overpaid')
  })

  it('enforces ownership and auth', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'GET', url: URL_BASE, headers })).statusCode).toBe(403)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'GET', url: URL_BASE, headers: { 'x-pilot-user-id': 'ghost' } })).statusCode).toBe(401)
  })
})

describe('PATCH /api/jobs/:jobId/payments/customer-total', () => {
  it('sets the customer total and returns the full summary', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any)
      .mockResolvedValueOnce(makeJob()) // ownership check
      .mockResolvedValue(makeJob({ customerTotalAmount: '4200', customerTotalCurrency: 'GBP' }))
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/customer-total`, headers, payload: { customerTotalAmount: '4200' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().customerTotalAmount).toBe('4200')
    const data = vi.mocked((prisma.job as any).update).mock.calls[0][0].data
    expect(data).toEqual({ customerTotalAmount: '4200', customerTotalCurrency: 'GBP' })
  })

  it('clears the customer total with null', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/customer-total`, headers, payload: { customerTotalAmount: null } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma.job as any).update).mock.calls[0][0].data
    expect(data).toEqual({ customerTotalAmount: null, customerTotalCurrency: null })
  })

  it('rejects non-decimal, non-positive, and non-GBP values', async () => {
    for (const payload of [
      { customerTotalAmount: 'lots' },
      { customerTotalAmount: '0' },
      { customerTotalAmount: '-5' },
      { customerTotalAmount: '100', customerTotalCurrency: 'EUR' },
    ]) {
      const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/customer-total`, headers, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().code).toBe('INVALID_FIELD')
    }
  })

  it('requires the customerTotalAmount field to be present', async () => {
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/customer-total`, headers, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })
})

describe('POST /api/jobs/:jobId/payments', () => {
  it('creates a payment and returns the payment shape', async () => {
    const res = await app.inject({ method: 'POST', url: URL_BASE, headers, payload: { amount: '500', paidAt: '2026-07-10T09:30:00.000Z', note: ' deposit ', reference: ' INV-001 ' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({ jobId: JOB_ID, amount: '500', currency: 'GBP', amountLabel: '£500', note: 'deposit', reference: 'INV-001' })
    expect(body).not.toHaveProperty('isDeleted')
  })

  it('stores a date-only paidAt as UK local noon', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'POST', url: URL_BASE, headers, payload: { amount: '500', paidAt: '2026-07-10' } })
    expect(res.statusCode).toBe(201)
    const data = vi.mocked((prisma as any).jobPayment.create).mock.calls[0][0].data
    expect(data.paidAt.toISOString()).toBe('2026-07-10T11:00:00.000Z')
  })

  it('trims note/reference and stores blank as null', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'POST', url: URL_BASE, headers, payload: { amount: '500', paidAt: '2026-07-10', note: '   ', reference: '' } })
    expect(res.statusCode).toBe(201)
    const data = vi.mocked((prisma as any).jobPayment.create).mock.calls[0][0].data
    expect(data.note).toBeNull()
    expect(data.reference).toBeNull()
  })

  it('validates amount, paidAt, currency, and note/reference lengths', async () => {
    for (const payload of [
      { paidAt: '2026-07-10' },                                        // missing amount
      { amount: 'about 500', paidAt: '2026-07-10' },                   // non-decimal
      { amount: '0', paidAt: '2026-07-10' },                           // non-positive
      { amount: '500' },                                               // missing paidAt
      { amount: '500', paidAt: 'not-a-date' },                         // invalid date
      { amount: '500', paidAt: '2026-07-10', currency: 'USD' },        // non-GBP
      { amount: '500', paidAt: '2026-07-10', note: 'x'.repeat(121) },  // note too long
      { amount: '500', paidAt: '2026-07-10', reference: 'x'.repeat(81) }, // reference too long
    ]) {
      const res = await app.inject({ method: 'POST', url: URL_BASE, headers, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
  })

  it('is owner-scoped', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'POST', url: URL_BASE, headers, payload: { amount: '500', paidAt: '2026-07-10' } })).statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'POST', url: URL_BASE, headers, payload: { amount: '500', paidAt: '2026-07-10' } })).statusCode).toBe(404)
  })
})

describe('PATCH /api/jobs/:jobId/payments/:paymentId', () => {
  beforeEach(async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPayment.findFirst).mockResolvedValue(makePayment({ reference: 'INV-001' }))
  })

  it('edits amount and paidAt, preserving omitted fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/${PAYMENT_ID}`, headers, payload: { amount: '750', paidAt: '2026-07-11' } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma as any).jobPayment.update).mock.calls[0][0].data
    expect(data.amount).toBe('750')
    expect(data.paidAt.toISOString()).toBe('2026-07-11T11:00:00.000Z')
    expect(data.note).toBe('deposit')       // preserved
    expect(data.reference).toBe('INV-001')  // preserved
  })

  it('clears note and reference with explicit nulls', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/${PAYMENT_ID}`, headers, payload: { note: null, reference: null } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma as any).jobPayment.update).mock.calls[0][0].data
    expect(data.note).toBeNull()
    expect(data.reference).toBeNull()
  })

  it('applies the same validation as create', async () => {
    for (const payload of [{ amount: 'x' }, { amount: '0' }, { paidAt: 'nope' }, { currency: 'USD' }]) {
      const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/${PAYMENT_ID}`, headers, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
  })

  it('404s for a deleted payment and for a payment outside the job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPayment.findFirst).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: `${URL_BASE}/gone`, headers, payload: { amount: '750' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PAYMENT_NOT_FOUND')
    // the lookup must exclude deleted rows and scope to the job
    const where = vi.mocked((prisma as any).jobPayment.findFirst).mock.calls[0][0].where
    expect(where).toMatchObject({ jobId: JOB_ID, isDeleted: false })
  })
})

describe('DELETE /api/jobs/:jobId/payments/:paymentId', () => {
  // DELETE carries no body, so no content-type header
  const deleteHeaders = { 'x-pilot-user-id': USER_ID }

  it('soft-deletes the payment and returns 204', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPayment.findFirst).mockResolvedValue(makePayment())
    const res = await app.inject({ method: 'DELETE', url: `${URL_BASE}/${PAYMENT_ID}`, headers: deleteHeaders })
    expect(res.statusCode).toBe(204)
    const call = vi.mocked((prisma as any).jobPayment.update).mock.calls[0][0]
    expect(call.data.isDeleted).toBe(true)
    expect(call.data.deletedAt).toBeInstanceOf(Date)
  })

  it('repeat delete returns 404 (already deleted rows are not found)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPayment.findFirst).mockResolvedValue(null)
    const res = await app.inject({ method: 'DELETE', url: `${URL_BASE}/${PAYMENT_ID}`, headers: deleteHeaders })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PAYMENT_NOT_FOUND')
  })

  it('is owner-scoped', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'DELETE', url: `${URL_BASE}/${PAYMENT_ID}`, headers: deleteHeaders })).statusCode).toBe(403)
  })
})

describe('separation from spend — payments never touch money-out totals', () => {
  it('budget-summary and memory-view never query payments and their totals ignore them', async () => {
    const { prisma } = await import('../src/db/client.js')
    // a job with a customer total and payments present
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ customerTotalAmount: '4200', customerTotalCurrency: 'GBP' }))
    vi.mocked((prisma as any).jobPayment.findMany).mockResolvedValue([makePayment({ amount: '1500' })])
    // one trusted material spend row
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([{
      id: 'mem-timber', jobId: JOB_ID, reviewDecisionId: 'rd-1', sourceCandidateFactId: null,
      memoryType: 'ORDERED_MATERIAL', isManual: true, summary: 'timber', materialName: 'timber',
      quantity: '1', unit: 'load', supplierName: null, deliveryTiming: null, locationOrUse: null,
      costAmount: null, costCurrency: 'GBP', costQualifier: null, totalCostAmount: '900',
      labourHours: null, labourPerson: null, labourTask: null, happenedAt: null,
      unresolvedFlags: [], budgetCategoryId: null, createdAt: new Date(), updatedAt: new Date(), sourceFact: null,
    }])
    vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])

    const budget = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/budget-summary`, headers })
    expect(budget.json().totals.knownSpendAmount).toBe('900')

    const view = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers })
    expect(view.json().costSummary.totalKnownCost.knownSpendAmount).toBe('900')

    // money-out endpoints never read the payments table
    expect(vi.mocked((prisma as any).jobPayment.findMany)).not.toHaveBeenCalled()
  })
})
