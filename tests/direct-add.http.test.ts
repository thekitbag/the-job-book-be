import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'da-user-1'
const JOB_ID = 'da-job-1'
const CAT_ID = 'da-cat-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    jobBudgetCategory: { findFirst: vi.fn(), findMany: vi.fn() },
    reviewDecision: { create: vi.fn() },
    memoryItem: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    queueItem: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
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
  return { id: JOB_ID, ownerUserId: USER_ID, title: 'Job', jobType: 'garden_room', status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makeCategory(overrides?: object) {
  return { id: CAT_ID, jobId: JOB_ID, name: 'timber', budgetAmount: null, budgetCurrency: null, sortOrder: 0, isArchived: false, createdAt: new Date(), updatedAt: new Date(), ...overrides }
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
  vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue({ id: 'rd-1' })
  // create() echoes the data so the normalized response reflects what was written
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    id: 'mem-new', createdAt: new Date(), updatedAt: new Date(), ...data,
  }))
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
})

const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const URL = `/api/jobs/${JOB_ID}/memory-items`
const post = (payload: any, h: any = headers) => app.inject({ method: 'POST', url: URL, headers: h, payload })
// data passed to the most recent memoryItem.create
async function lastCreateData() {
  const { prisma } = await import('../src/db/client.js')
  const calls = vi.mocked(prisma.memoryItem.create as any).mock.calls
  return calls[calls.length - 1][0].data
}

describe('POST /api/jobs/:jobId/memory-items — direct add', () => {
  it('creates trusted manual spend (ordered_material) with isManual and null source', async () => {
    const res = await post({ memoryType: 'ordered_material', materialName: 'timber', quantity: '2', unit: 'loads', costAmount: '900', costQualifier: 'total' })
    expect(res.statusCode).toBe(201)
    const body = res.json<Record<string, any>>()
    expect(body.memoryType).toBe('ordered_material')
    expect(body.isManual).toBe(true)
    expect(body.source).toBeNull()
    expect(body.sourceCandidateFactId).toBeNull()
    // derived summary + stated total counted + GBP defaulted
    expect(body.summary).toBe('Bought 2 loads timber')
    expect(body.totalCostAmount).toBe('900')
    expect(body.costCurrency).toBe('GBP')
  })

  it('creates an ADD_MISSING review decision with empty source facts', async () => {
    const { prisma } = await import('../src/db/client.js')
    await post({ memoryType: 'ordered_material', materialName: 'timber', costAmount: '50', costQualifier: 'total' })
    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      action: 'ADD_MISSING', candidateFactId: null, sourceCandidateFactIds: [], sectionKey: 'ordered_materials',
    }) }))
  })

  it('manual spend without cost is remembered but has no total', async () => {
    const res = await post({ memoryType: 'ordered_material', materialName: 'sand' })
    expect(res.statusCode).toBe(201)
    expect(res.json<Record<string, any>>().totalCostAmount).toBeNull()
  })

  it('creates manual labour with happenedAt, person, hours and task', async () => {
    const res = await post({ memoryType: 'labour', happenedAt: '2026-07-01', labourPerson: 'Tom', labourHours: '8', labourTask: 'electrics' })
    expect(res.statusCode).toBe(201)
    const body = res.json<Record<string, any>>()
    expect(body.memoryType).toBe('labour')
    expect(body.labourHours).toBe('8')
    expect(body.labourPerson).toBe('Tom')
    expect(body.happenedAt).toBeTruthy()
    expect(body.summary).toBe('Tom — 8 hours · electrics')
  })

  it('derives a per_hour labour total', async () => {
    await post({ memoryType: 'labour', labourHours: '8', labourPerson: 'Tom', costAmount: '35', costQualifier: 'per_hour' })
    expect((await lastCreateData()).totalCostAmount).toBe('280')
  })

  it('creates manual used material with no cost total', async () => {
    const res = await post({ memoryType: 'used_material', materialName: 'screws', quantity: '20', unit: 'pcs' })
    expect(res.statusCode).toBe(201)
    const body = res.json<Record<string, any>>()
    expect(body.memoryType).toBe('used_material')
    expect(body.summary).toBe('Used 20 pcs screws')
    expect(body.totalCostAmount).toBeNull()
  })

  it('creates a plain general_note', async () => {
    const res = await post({ memoryType: 'general_note', summary: 'Client prefers grey cladding' })
    expect(res.statusCode).toBe(201)
    expect(res.json<Record<string, any>>().memoryType).toBe('general_note')
  })

  it('creates a typed note (watch_out)', async () => {
    const res = await post({ memoryType: 'watch_out', summary: 'Watch the soft ground by the fence' })
    expect(res.statusCode).toBe(201)
    expect(res.json<Record<string, any>>().memoryType).toBe('watch_out')
  })

  // ── Validation ──────────────────────────────────────────────────────────────

  it('rejects a missing memoryType', async () => {
    expect((await post({ summary: 'x' })).statusCode).toBe(400)
  })
  it('rejects unclear memoryType', async () => {
    expect((await post({ memoryType: 'unclear', summary: 'x' })).statusCode).toBe(400)
  })
  it('rejects an invalid decimal', async () => {
    expect((await post({ memoryType: 'ordered_material', materialName: 'x', costAmount: 'lots' })).statusCode).toBe(400)
  })
  it('rejects an invalid happenedAt', async () => {
    expect((await post({ memoryType: 'labour', labourHours: '2', happenedAt: 'not-a-date' })).statusCode).toBe(400)
  })
  it('rejects a blank note with no derivable summary', async () => {
    expect((await post({ memoryType: 'general_note' })).statusCode).toBe(400)
  })
  it('rejects a category on a non-eligible memory type', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeCategory())
    expect((await post({ memoryType: 'used_material', materialName: 'x', budgetCategoryId: CAT_ID })).statusCode).toBe(400)
  })
  it('allows a category on ordered_material', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeCategory())
    const res = await post({ memoryType: 'ordered_material', materialName: 'timber', costAmount: '50', costQualifier: 'total', budgetCategoryId: CAT_ID })
    expect(res.statusCode).toBe(201)
    expect(res.json<Record<string, any>>().budgetCategoryId).toBe(CAT_ID)
  })
  it('rejects an archived category (400) and another-job category (404)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeCategory({ isArchived: true }))
    expect((await post({ memoryType: 'labour', labourHours: '2', budgetCategoryId: CAT_ID })).statusCode).toBe(400)
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
    expect((await post({ memoryType: 'labour', labourHours: '2', budgetCategoryId: 'other' })).statusCode).toBe(404)
  })
  it('rejects unauthenticated (401), non-owner (403) and missing job (404)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(null)
    expect((await post({ memoryType: 'general_note', summary: 'x' }, { 'x-pilot-user-id': 'ghost', 'content-type': 'application/json' })).statusCode).toBe(401)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: 'other' }))
    expect((await post({ memoryType: 'general_note', summary: 'x' })).statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await post({ memoryType: 'general_note', summary: 'x' })).statusCode).toBe(404)
  })
})

describe('direct-add items in memory-view and budget-summary', () => {
  function manual(overrides: any) {
    return {
      id: 'm1', jobId: JOB_ID, reviewDecisionId: 'rd-1', sourceCandidateFactId: null, isManual: true,
      memoryType: 'ORDERED_MATERIAL', summary: 'Manual', materialName: null, quantity: null, unit: null,
      supplierName: null, deliveryTiming: null, locationOrUse: null, costAmount: null, costCurrency: null,
      costQualifier: null, totalCostAmount: null, labourHours: null, labourPerson: null, labourTask: null,
      happenedAt: null, unresolvedFlags: [], budgetCategoryId: null, createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    }
  }

  it('places a manual general_note in the general_notes section with source null', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([manual({ memoryType: 'GENERAL_NOTE', summary: 'Client note' })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers: { 'x-pilot-user-id': USER_ID } })
    const section = res.json<any>().sections.find((s: any) => s.key === 'general_notes')
    expect(section.items).toHaveLength(1)
    expect(section.items[0].summary).toBe('Client note')
    expect(section.items[0].isManual).toBe(true)
    expect(section.items[0].source).toBeNull()
  })

  it('includes manual spend with a safe total in budget-summary', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      manual({ id: 'paid', memoryType: 'ORDERED_MATERIAL', materialName: 'timber', totalCostAmount: '900', costCurrency: 'GBP' }),
      manual({ id: 'nocost', memoryType: 'ORDERED_MATERIAL', materialName: 'sand', totalCostAmount: null }),
    ])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/budget-summary`, headers: { 'x-pilot-user-id': USER_ID } })
    const body = res.json<any>()
    expect(body.totals.knownSpendAmount).toBe('900')
    expect(body.uncategorized.rows.map((r: any) => r.memoryItemId)).toEqual(['paid'])
  })

  it('patches a manual item happenedAt via the existing edit path', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(manual({ memoryType: 'LABOUR', labourHours: '8', labourPerson: 'Tom' }))
    vi.mocked(prisma.memoryItem.update as any).mockImplementation(async ({ data }: any) => ({ ...manual({ memoryType: 'LABOUR' }), ...data, sourceFact: null }))
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${JOB_ID}/memory-items/m1`,
      headers,
      payload: { memoryType: 'labour', summary: 'Tom 8h', labourHours: '8', happenedAt: '2026-07-02' },
    })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.memoryItem.update as any).mock.calls[0][0]
    expect(call.data.happenedAt).toBeInstanceOf(Date)
    expect(res.json<any>().happenedAt).toBeTruthy()
  })
})
