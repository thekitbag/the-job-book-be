// Returned materials: a Left over item can be returned in full or in part via
// POST /memory-items/:id/return. A full return soft-removes the source leftover
// (evidence preserved); a partial return reduces its quantity. The returned item
// is a RETURNED_MATERIAL memory carrying returned quantity/merchant and, when
// trusted, a refund that reduces net known spend without erasing purchase history.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'ret-user-1'
const OTHER_USER_ID = 'ret-user-2'
const JOB_ID = 'ret-job-1'
const LEFTOVER_ID = 'ret-leftover-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    memoryItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    reviewDecision: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    candidateFact: { findMany: vi.fn(), deleteMany: vi.fn() },
    rawNote: { findMany: vi.fn(), deleteMany: vi.fn() },
    transcript: { deleteMany: vi.fn() },
    jobBudgetCategory: { findMany: vi.fn(), findFirst: vi.fn() },
    jobPayment: { findMany: vi.fn() },
    queueItem: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

function makeUser(overrides?: object) {
  return { id: USER_ID, email: 'p@t.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makeJob(overrides?: object) {
  return {
    id: JOB_ID, ownerUserId: USER_ID, title: 'Job', jobType: 'garden_room', status: 'STARTED',
    roughLocationOrLabel: null, notes: null, customerTotalAmount: null, customerTotalCurrency: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  }
}
function makeMemory(overrides?: object) {
  return {
    id: LEFTOVER_ID, jobId: JOB_ID, reviewDecisionId: 'rd-1', sourceCandidateFactId: null,
    memoryType: 'LEFTOVER_MATERIAL', isManual: true, summary: 'Fence posts', materialName: 'Fence posts',
    quantity: '6', unit: 'posts', supplierName: null, deliveryTiming: null, locationOrUse: null,
    costAmount: null, costCurrency: 'GBP', costQualifier: null, totalCostAmount: null,
    labourHours: null, labourPerson: null, labourTask: null, happenedAt: null,
    unresolvedFlags: [], budgetCategoryId: null,
    isRemoved: false, removedAt: null, removedByUserId: null, removedReason: null,
    returnedFromMemoryItemId: null, refundAmount: null, refundCurrency: null,
    createdAt: new Date(), updatedAt: new Date(), sourceFact: null,
    ...overrides,
  }
}

let app: FastifyInstance
let storage: FakeAudioStorage

beforeAll(async () => {
  storage = new FakeAudioStorage()
  app = buildApp({ storage, transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(async () => {
  vi.clearAllMocks()
  storage.clear()
  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue({ id: 'rd-new' })
  // create() echoes the written data (with row defaults) so the normalized
  // response reflects exactly what was persisted.
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    id: 'ret-new', unresolvedFlags: [], budgetCategoryId: null, isRemoved: false,
    removedAt: null, removedByUserId: null, removedReason: null, deliveryTiming: null,
    locationOrUse: null, costAmount: null, costCurrency: null, costQualifier: null,
    totalCostAmount: null, labourHours: null, labourPerson: null, labourTask: null,
    createdAt: new Date(), updatedAt: new Date(), sourceFact: null, ...data,
  }))
  vi.mocked(prisma.memoryItem.update as any).mockImplementation(async ({ data }: any) => ({
    ...makeMemory(), ...data, sourceFact: null,
  }))
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as any).mockResolvedValue({ count: 0 })
})

const authHeaders = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const RETURN_URL = `/api/jobs/${JOB_ID}/memory-items/${LEFTOVER_ID}/return`
const post = (payload: any, h: any = authHeaders) => app.inject({ method: 'POST', url: RETURN_URL, headers: h, payload })

describe('POST return — partial return', () => {
  it('creates a returned item and reduces the source leftover quantity', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ quantity: '6' }))
    const res = await post({ quantity: '4', supplierName: 'Jewson', refundAmount: '80', refundCurrency: 'GBP' })
    expect(res.statusCode).toBe(201)
    const body = res.json()

    // Returned item: RETURNED_MATERIAL, returned qty, merchant, refund, source link
    expect(body.returnedItem.memoryType).toBe('returned_material')
    const createData = vi.mocked(prisma.memoryItem.create as any).mock.calls[0][0].data
    expect(createData.memoryType).toBe('RETURNED_MATERIAL')
    expect(createData.quantity).toBe('4')
    expect(createData.unit).toBe('posts') // defaulted from source
    expect(createData.supplierName).toBe('Jewson')
    expect(createData.refundAmount).toBe('80')
    expect(createData.refundCurrency).toBe('GBP')
    expect(createData.returnedFromMemoryItemId).toBe(LEFTOVER_ID)
    expect(body.returnedItem.refundLabel).toBe('£80 refund')

    // Source leftover reduced to remaining, NOT removed
    const updateCall = vi.mocked(prisma.memoryItem.update as any).mock.calls[0][0]
    expect(updateCall.where.id).toBe(LEFTOVER_ID)
    expect(updateCall.data.quantity).toBe('2')
    expect('isRemoved' in updateCall.data).toBe(false)
    expect(body.remainingLeftoverItem.quantity).toBe('2')
  })
})

describe('POST return — full return', () => {
  it('soft-removes the source leftover with reason returned and no remaining item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ quantity: '6' }))
    const res = await post({ quantity: '6', supplierName: 'Jewson' })
    expect(res.statusCode).toBe(201)
    expect(res.json().remainingLeftoverItem).toBeNull()

    const updateCall = vi.mocked(prisma.memoryItem.update as any).mock.calls[0][0]
    expect(updateCall.data.isRemoved).toBe(true)
    expect(updateCall.data.removedReason).toBe('returned')
    expect(updateCall.data.removedByUserId).toBe(USER_ID)
    expect(vi.mocked(prisma.memoryItem.delete as any)).not.toHaveBeenCalled()
  })

  it('preserves source evidence — no note/transcript/fact/decision deletion', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ quantity: '6', sourceCandidateFactId: 'cf-1' }))
    const res = await post({ quantity: '6' })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked(prisma.rawNote.deleteMany as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.transcript.deleteMany as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.candidateFact.deleteMany as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.reviewDecision.deleteMany as any)).not.toHaveBeenCalled()
  })
})

describe('POST return — rejections (no mutation)', () => {
  const expectNoMutation = async () => {
    const { prisma } = await import('../src/db/client.js')
    expect(vi.mocked(prisma.memoryItem.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.memoryItem.update as any)).not.toHaveBeenCalled()
  }

  it('over-return is rejected 400 INVALID_FIELD', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ quantity: '6' }))
    const res = await post({ quantity: '7' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    await expectNoMutation()
  })

  it('non-leftover source is rejected 400 INVALID_FIELD', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ memoryType: 'ORDERED_MATERIAL', quantity: '6' }))
    const res = await post({ quantity: '2' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    await expectNoMutation()
  })

  it('non-numeric leftover quantity cannot be safely compared → 400', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ quantity: 'a few' }))
    const res = await post({ quantity: '2' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    await expectNoMutation()
  })

  it('missing quantity → 400 MISSING_FIELD', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory())
    const res = await post({ supplierName: 'Jewson' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it.each(['abc', '0', '-3', '£4'])('invalid quantity %s → 400 INVALID_FIELD', async (q) => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory())
    const res = await post({ quantity: q })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('invalid refund amount → 400', async () => {
    const res = await post({ quantity: '2', refundAmount: 'lots' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('non-GBP refund currency → 400', async () => {
    const res = await post({ quantity: '2', refundAmount: '5', refundCurrency: 'USD' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('invalid happenedAt → 400', async () => {
    const res = await post({ quantity: '2', happenedAt: 'not-a-date' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('unknown item → 404 MEMORY_ITEM_NOT_FOUND', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
    const res = await post({ quantity: '2' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('MEMORY_ITEM_NOT_FOUND')
    // active-only lookup
    const where = vi.mocked(prisma.memoryItem.findFirst as any).mock.calls[0][0].where
    expect(where).toMatchObject({ id: LEFTOVER_ID, jobId: JOB_ID, isRemoved: false })
  })
})

describe('POST return — ownership', () => {
  it('non-owner → 403, unknown job → 404, and neither mutates', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await post({ quantity: '2' })).statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await post({ quantity: '2' })).statusCode).toBe(404)
    expect(vi.mocked(prisma.memoryItem.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.memoryItem.update as any)).not.toHaveBeenCalled()
  })
})

// ── Read side: memory-view sections + refund/net cost summary ──────────────────

describe('memory-view — Returned section and refund summary', () => {
  const memoryView = () => app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers: { 'x-pilot-user-id': USER_ID } })

  it('normalizes returned_material into the Returned section with refund fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'r1', memoryType: 'RETURNED_MATERIAL', summary: 'Returned 4 posts', materialName: 'Fence posts',
        quantity: '4', unit: 'posts', supplierName: 'Jewson', refundAmount: '80', refundCurrency: 'GBP', returnedFromMemoryItemId: LEFTOVER_ID }),
    ])
    const body = (await memoryView()).json()
    const section = body.sections.find((s: any) => s.key === 'returned_materials')
    expect(section.items).toHaveLength(1)
    const item = section.items[0]
    expect(item.memoryType).toBe('returned_material')
    expect(item.refundAmount).toBe('80')
    expect(item.refundLabel).toBe('£80 refund')
    expect(item.returnedFromMemoryItemId).toBe(LEFTOVER_ID)
  })

  it('a trusted refund reduces net totalKnownCost while gross stays and a refund row shows', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'bought', memoryType: 'ORDERED_MATERIAL', materialName: 'Fence posts', totalCostAmount: '300', costCurrency: 'GBP' }),
      makeMemory({ id: 'r1', memoryType: 'RETURNED_MATERIAL', materialName: 'Fence posts', quantity: '4', unit: 'posts',
        supplierName: 'Jewson', refundAmount: '80', refundCurrency: 'GBP' }),
    ])
    const cost = (await memoryView()).json().costSummary
    expect(cost.grossKnownCost.knownSpendAmount).toBe('300')
    expect(cost.refunds.knownRefundAmount).toBe('80')
    expect(cost.refunds.knownRefundLabel).toBe('£80 refunded')
    expect(cost.refunds.rows).toHaveLength(1)
    expect(cost.refunds.rows[0].refundLabel).toBe('£80 refund')
    expect(cost.totalKnownCost.knownSpendAmount).toBe('220') // net: 300 − 80
  })

  it('a returned item without a trusted refund does not reduce spend', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'bought', memoryType: 'ORDERED_MATERIAL', materialName: 'Fence posts', totalCostAmount: '300', costCurrency: 'GBP' }),
      makeMemory({ id: 'r1', memoryType: 'RETURNED_MATERIAL', materialName: 'Fence posts', quantity: '4', unit: 'posts' }),
    ])
    const cost = (await memoryView()).json().costSummary
    expect(cost.refunds.knownRefundAmount).toBeNull()
    expect(cost.refunds.rows).toHaveLength(0)
    expect(cost.totalKnownCost.knownSpendAmount).toBe('300')
  })

  it('non-GBP or flagged refunds are excluded from net spend', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'bought', memoryType: 'ORDERED_MATERIAL', totalCostAmount: '300', costCurrency: 'GBP' }),
      makeMemory({ id: 'usd', memoryType: 'RETURNED_MATERIAL', refundAmount: '50', refundCurrency: 'USD' }),
      makeMemory({ id: 'flagged', memoryType: 'RETURNED_MATERIAL', refundAmount: '50', refundCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])
    const cost = (await memoryView()).json().costSummary
    expect(cost.refunds.rows).toHaveLength(0)
    expect(cost.totalKnownCost.knownSpendAmount).toBe('300')
  })
})

describe('budget-summary — net known spend after refunds', () => {
  const budget = () => app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/budget-summary`, headers: { 'x-pilot-user-id': USER_ID } })

  it('exposes net known spend and a refund adjustment; categories stay gross', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'bought', memoryType: 'ORDERED_MATERIAL', totalCostAmount: '300', costCurrency: 'GBP' }),
      makeMemory({ id: 'r1', memoryType: 'RETURNED_MATERIAL', refundAmount: '80', refundCurrency: 'GBP' }),
    ])
    const totals = (await budget()).json().totals
    expect(totals.knownSpendAmount).toBe('300') // gross, matches visible rows
    expect(totals.knownRefundAmount).toBe('80')
    expect(totals.netKnownSpendAmount).toBe('220')
  })

  it('no-refund returned item leaves net equal to gross', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({ id: 'bought', memoryType: 'ORDERED_MATERIAL', totalCostAmount: '300', costCurrency: 'GBP' }),
      makeMemory({ id: 'r1', memoryType: 'RETURNED_MATERIAL', quantity: '4' }),
    ])
    const totals = (await budget()).json().totals
    expect(totals.knownRefundAmount).toBeNull()
    expect(totals.netKnownSpendAmount).toBe('300')
  })
})
