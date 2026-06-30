import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'bud-user-1'
const JOB_ID = 'bud-job-1'
const CAT_ID = 'bud-cat-1'
const MEMORY_ID = 'bud-memory-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    jobBudgetCategory: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    memoryItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // Needed so memory-view can run alongside budget-summary in the invariant test.
    candidateFact: { findMany: vi.fn() },
    queueItem: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

function makeUser(overrides?: object) {
  return { id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...overrides }
}

function makeJob(overrides?: object) {
  return { id: JOB_ID, ownerUserId: USER_ID, title: 'Garden room', jobType: 'garden_room', status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(), ...overrides }
}

function makeCategory(overrides?: object) {
  return {
    id: CAT_ID,
    jobId: JOB_ID,
    name: 'timber',
    budgetAmount: null as string | null,
    budgetCurrency: null as string | null,
    sortOrder: 0,
    isArchived: false,
    createdAt: new Date('2026-06-28T08:00:00.000Z'),
    updatedAt: new Date('2026-06-28T08:00:00.000Z'),
    ...overrides,
  }
}

function makeMemory(overrides?: object) {
  return {
    id: MEMORY_ID,
    jobId: JOB_ID,
    reviewDecisionId: 'rd-1',
    sourceCandidateFactId: null,
    memoryType: 'ORDERED_MATERIAL',
    isManual: false,
    summary: 'Ordered timber',
    materialName: 'timber',
    quantity: '1',
    unit: 'load',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: null,
    costAmount: null,
    costCurrency: 'GBP',
    costQualifier: null,
    totalCostAmount: '1850',
    labourHours: null as string | null,
    labourPerson: null as string | null,
    labourTask: null as string | null,
    unresolvedFlags: [] as string[],
    budgetCategoryId: null as string | null,
    createdAt: new Date('2026-06-28T09:00:00.000Z'),
    updatedAt: new Date('2026-06-28T09:00:00.000Z'),
    ...overrides,
  }
}

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  vi.clearAllMocks()
  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())
  vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  vi.mocked(prisma.jobBudgetCategory.create as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ data }: { data: object }) => ({ id: CAT_ID, createdAt: new Date(), updatedAt: new Date(), isArchived: false, sortOrder: 0, ...data }),
  )
  vi.mocked(prisma.jobBudgetCategory.update as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ data }: { data: object }) => ({ ...makeCategory(), ...data, updatedAt: new Date() }),
  )
  vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory())
  vi.mocked(prisma.memoryItem.update as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ data }: { data: object }) => ({ ...makeMemory(), ...data, sourceFact: null }),
  )
  vi.mocked(prisma.memoryItem.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

const headers = { 'x-pilot-user-id': USER_ID }
const CATS_URL = `/api/jobs/${JOB_ID}/budget-categories`
const SUMMARY_URL = `/api/jobs/${JOB_ID}/budget-summary`

// ── Category CRUD ─────────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/budget-categories', () => {
  it('creates a category with name only (no budget)', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: '  timber  ' } })
    expect(res.statusCode).toBe(201)
    const body = res.json<Record<string, unknown>>()
    expect(body.name).toBe('timber')          // trimmed
    expect(body.budgetAmount).toBeNull()
    expect(body.budgetCurrency).toBeNull()
  })

  it('creates a category with a GBP budget amount and defaults currency to GBP', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'timber', budgetAmount: '4000' } })
    expect(res.statusCode).toBe(201)
    const body = res.json<Record<string, unknown>>()
    expect(body.budgetAmount).toBe('4000')
    expect(body.budgetCurrency).toBe('GBP')
  })

  it('rejects a blank name', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: '   ' } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a name longer than 60 characters', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'x'.repeat(61) } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an invalid budget amount', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'timber', budgetAmount: 'about 400' } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-GBP budget currency', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'timber', budgetAmount: '400', budgetCurrency: 'EUR' } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a negative sortOrder', async () => {
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'timber', sortOrder: -1 } })
    expect(res.statusCode).toBe(400)
  })

  it('requires the job to be owned by the requesting user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob({ ownerUserId: 'someone-else' }))
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers, payload: { name: 'timber' } })
    expect(res.statusCode).toBe(403)
  })

  it('rejects unauthenticated requests', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'POST', url: CATS_URL, headers: { 'x-pilot-user-id': 'ghost' }, payload: { name: 'timber' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /api/jobs/:jobId/budget-categories', () => {
  it('lists active categories only', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeCategory({ budgetAmount: '4000', budgetCurrency: 'GBP' })])
    const res = await app.inject({ method: 'GET', url: CATS_URL, headers })
    expect(res.statusCode).toBe(200)
    expect(res.json<unknown[]>()).toHaveLength(1)
    // service filters to active categories at the DB layer
    const call = vi.mocked(prisma.jobBudgetCategory.findMany).mock.calls[0][0] as { where: Record<string, unknown> }
    expect(call.where).toMatchObject({ jobId: JOB_ID, isArchived: false })
  })

  it('returns 404 when the job does not exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: CATS_URL, headers })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/jobs/:jobId/budget-categories/:categoryId', () => {
  it('edits name and budget amount', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory())
    const res = await app.inject({ method: 'PATCH', url: `${CATS_URL}/${CAT_ID}`, headers, payload: { name: 'timber & sheet', budgetAmount: '5000' } })
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.name).toBe('timber & sheet')
    expect(body.budgetAmount).toBe('5000')
    expect(body.budgetCurrency).toBe('GBP')
  })

  it('archives a category and clears assigned memory items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory())
    const res = await app.inject({ method: 'PATCH', url: `${CATS_URL}/${CAT_ID}`, headers, payload: { isArchived: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Record<string, unknown>>().isArchived).toBe(true)
    expect(prisma.memoryItem.updateMany).toHaveBeenCalledWith({
      where: { jobId: JOB_ID, budgetCategoryId: CAT_ID },
      data: { budgetCategoryId: null },
    })
  })

  it('returns 404 for a category not in the job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: `${CATS_URL}/missing`, headers, payload: { name: 'x' } })
    expect(res.statusCode).toBe(404)
  })
})

// ── Memory-item category assignment ───────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — budgetCategoryId', () => {
  const MI_URL = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}`

  it('assigns a memory item to a category in the same job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory())
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'ordered_material', budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Record<string, unknown>>().budgetCategoryId).toBe(CAT_ID)
  })

  it('rejects assignment to another job\'s category with 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'ordered_material', budgetCategoryId: 'other-job-cat' } })
    expect(res.statusCode).toBe(404)
  })

  it('rejects assignment to an archived category with 400', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory({ isArchived: true }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'ordered_material', budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(400)
  })

  it('clears a memory item category with null', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory({ budgetCategoryId: CAT_ID }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'ordered_material', budgetCategoryId: null } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Record<string, unknown>>().budgetCategoryId).toBeNull()
  })

  // ── Category-only body (no memoryType) ──────────────────────────────────────

  it('assigns a category with a category-only body (no memoryType)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory())
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.budgetCategoryId).toBe(CAT_ID)
    // existing memory fields are left unchanged
    expect(body.summary).toBe('Ordered timber')
    expect(body.materialName).toBe('timber')
    // and only budgetCategoryId is written at the DB layer
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data).toEqual({ budgetCategoryId: CAT_ID })
  })

  it('clears a category with a category-only body (no memoryType)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory({ budgetCategoryId: CAT_ID }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { budgetCategoryId: null } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Record<string, unknown>>().budgetCategoryId).toBeNull()
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data).toEqual({ budgetCategoryId: null })
  })

  it('rejects a category-only assignment to another job\'s category with 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { budgetCategoryId: 'other-job-cat' } })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a category-only assignment to a nonexistent category with 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { budgetCategoryId: 'ghost-cat' } })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a category-only assignment to an archived category with 400', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory({ isArchived: true }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty body with no memoryType and no budgetCategoryId', async () => {
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('still applies a full memory edit when memoryType and fields are submitted', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({
      method: 'PATCH',
      url: MI_URL,
      headers,
      payload: { memoryType: 'ordered_material', summary: 'Corrected: 2 loads of timber', materialName: 'timber', quantity: '2' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body.summary).toBe('Corrected: 2 loads of timber')
    expect(body.quantity).toBe('2')
    // full path writes the memory fields, not just budgetCategoryId
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data).toHaveProperty('summary', 'Corrected: 2 loads of timber')
    expect(call.data).toHaveProperty('memoryType', 'ORDERED_MATERIAL')
  })

  it('rejects assigning a category to a non-ordered memory type with 400', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory())
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'used_material', summary: 'Used it', budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(400)
  })

  it('clears an existing category when the memory type changes away from ordered', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory({ budgetCategoryId: CAT_ID }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers, payload: { memoryType: 'used_material', summary: 'Used the timber' } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data.budgetCategoryId).toBeNull()
  })
})

// ── Cross-summary known-spend invariant ───────────────────────────────────────

describe('budget-summary and memory-view agree on job-level known cost', () => {
  it('totals.knownSpendAmount equals memory-view costSummary.totalKnownCost (material + labour)', async () => {
    const { prisma } = await import('../src/db/client.js')
    const mixed = [
      makeMemory({ id: 'cat', budgetCategoryId: CAT_ID, totalCostAmount: '1850', costCurrency: 'GBP' }),
      makeMemory({ id: 'unc', budgetCategoryId: null, totalCostAmount: '320', costCurrency: 'GBP' }),
      // labour: explicit total contributes; hours-only does not
      makeMemory({ id: 'lab-paid', memoryType: 'LABOUR', materialName: null, labourTask: 'electrics', totalCostAmount: '280', costCurrency: 'GBP' }),
      makeMemory({ id: 'lab-hours', memoryType: 'LABOUR', materialName: null, labourHours: '6', labourTask: 'cladding', totalCostAmount: null, costCurrency: null }),
      makeMemory({ id: 'missing', totalCostAmount: null }),
      makeMemory({ id: 'unresolved', totalCostAmount: '99', unresolvedFlags: ['cost_uncertain'] }),
      makeMemory({ id: 'eur', totalCostAmount: '70', costCurrency: 'EUR' }),
      makeMemory({ id: 'used', memoryType: 'USED_MATERIAL', totalCostAmount: '80', costCurrency: 'GBP' }),
    ]
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(mixed)
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeCategory({ id: CAT_ID, budgetAmount: '4000', budgetCurrency: 'GBP' })])

    const budgetRes = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const memoryRes = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers })

    const budgetTotal = budgetRes.json<{ totals: { knownSpendAmount: string | null } }>().totals.knownSpendAmount
    const memoryView = memoryRes.json<{ costSummary: { orderedMaterials: { knownSpendAmount: string | null }; totalKnownCost: { knownSpendAmount: string | null } } }>().costSummary

    expect(budgetTotal).toBe('2450') // 1850 + 320 + 280 labour
    expect(budgetTotal).toBe(memoryView.totalKnownCost.knownSpendAmount)
    // ordered-materials-only known spend stays material-only for compatibility
    expect(memoryView.orderedMaterials.knownSpendAmount).toBe('2170')
  })
})

// ── Budget summary ────────────────────────────────────────────────────────────

interface SummaryBody {
  categories: Array<{
    category: { id: string }
    knownSpendAmount: string | null
    budgetAmount: string | null
    budgetLabel: string | null
    remainingAmount: string | null
    overBudget: boolean
    rows: Array<{ memoryItemId: string; itemLabel: string; lineTotalAmount: string }>
  }>
  uncategorized: { knownSpendAmount: string | null; rows: Array<{ memoryItemId: string }> }
  totals: { budgetAmount: string | null; knownSpendAmount: string | null; remainingAmount: string | null; overBudget: boolean }
}

describe('GET /api/jobs/:jobId/budget-summary', () => {
  it('puts a safe trusted ordered GBP item under its assigned category', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCategory({ id: CAT_ID, budgetAmount: '4000', budgetCurrency: 'GBP' }),
    ])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'm1', budgetCategoryId: CAT_ID, totalCostAmount: '1850' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json<SummaryBody>()
    expect(body.categories).toHaveLength(1)
    const cat = body.categories[0]
    expect(cat.knownSpendAmount).toBe('1850')
    expect(cat.budgetLabel).toBe('£4000 budget')
    expect(cat.remainingAmount).toBe('2150')
    expect(cat.overBudget).toBe(false)
    expect(cat.rows).toHaveLength(1)
    expect(cat.rows[0].memoryItemId).toBe('m1')
    expect(body.uncategorized.rows).toHaveLength(0)
  })

  it('excludes pending/unresolved/missing-cost/non-GBP/used items from category spend', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCategory({ id: CAT_ID, budgetAmount: '4000', budgetCurrency: 'GBP' }),
    ])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'safe', budgetCategoryId: CAT_ID, totalCostAmount: '100' }),
      makeMemory({ id: 'unresolved', budgetCategoryId: CAT_ID, totalCostAmount: '50', unresolvedFlags: ['cost_uncertain'] }),
      makeMemory({ id: 'missing', budgetCategoryId: CAT_ID, totalCostAmount: null }),
      makeMemory({ id: 'eur', budgetCategoryId: CAT_ID, totalCostAmount: '70', costCurrency: 'EUR' }),
      makeMemory({ id: 'used', budgetCategoryId: CAT_ID, memoryType: 'USED_MATERIAL', totalCostAmount: '80' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    const cat = body.categories[0]
    expect(cat.rows.map((r) => r.memoryItemId)).toEqual(['safe'])
    expect(cat.knownSpendAmount).toBe('100')
    expect(body.totals.knownSpendAmount).toBe('100')
  })

  it('reports safe spend with no category under uncategorized', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'u1', budgetCategoryId: null, materialName: null, summary: 'Jewson order', totalCostAmount: '320' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    expect(body.categories).toHaveLength(0)
    expect(body.uncategorized.knownSpendAmount).toBe('320')
    expect(body.uncategorized.rows[0].memoryItemId).toBe('u1')
    expect(body.uncategorized.rows[0].itemLabel).toBe('Jewson order') // summary fallback
  })

  it('computes over-budget when spend exceeds budget', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCategory({ id: CAT_ID, budgetAmount: '100', budgetCurrency: 'GBP' }),
    ])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'm1', budgetCategoryId: CAT_ID, totalCostAmount: '150' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    expect(body.categories[0].overBudget).toBe(true)
    expect(body.categories[0].remainingAmount).toBe('-50')
    expect(body.totals.overBudget).toBe(true)
  })

  it('leaves remaining null and overBudget false when a category has no budget amount', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCategory({ id: CAT_ID, budgetAmount: null }),
    ])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'm1', budgetCategoryId: CAT_ID, totalCostAmount: '900' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    expect(body.categories[0].knownSpendAmount).toBe('900')
    expect(body.categories[0].budgetLabel).toBeNull()
    expect(body.categories[0].remainingAmount).toBeNull()
    expect(body.categories[0].overBudget).toBe(false)
    expect(body.totals.budgetAmount).toBeNull()
  })

  it('sums totals across categorized and uncategorized safe spend', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeCategory({ id: CAT_ID, budgetAmount: '4000', budgetCurrency: 'GBP' }),
    ])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'cat', budgetCategoryId: CAT_ID, totalCostAmount: '1850' }),
      makeMemory({ id: 'unc', budgetCategoryId: null, totalCostAmount: '320' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    expect(body.totals.budgetAmount).toBe('4000')
    expect(body.totals.knownSpendAmount).toBe('2170')
    expect(body.totals.remainingAmount).toBe('1830')
    expect(body.totals.overBudget).toBe(false)
  })

  it('enforces ownership', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob({ ownerUserId: 'someone-else' }))
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    expect(res.statusCode).toBe(403)
  })
})

// ── Labour in budget summary (labour-hours-cost-memory) ───────────────────────

describe('budget-summary — labour', () => {
  it('includes safe labour monetary rows and excludes hours-only labour', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'paid', memoryType: 'LABOUR', materialName: null, labourTask: 'electrics', totalCostAmount: '280', costCurrency: 'GBP' }),
      makeMemory({ id: 'hours', memoryType: 'LABOUR', materialName: null, labourHours: '6', labourTask: 'cladding', totalCostAmount: null, costCurrency: null }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const body = res.json<SummaryBody>()
    expect(body.uncategorized.rows.map((r) => r.memoryItemId)).toEqual(['paid'])
    expect(body.totals.knownSpendAmount).toBe('280')
  })

  it('row carries memoryType and labour fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobBudgetCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'paid', memoryType: 'LABOUR', materialName: null, labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics', totalCostAmount: '280', costCurrency: 'GBP' }),
    ])
    const res = await app.inject({ method: 'GET', url: SUMMARY_URL, headers })
    const row = res.json<{ uncategorized: { rows: Array<Record<string, unknown>> } }>().uncategorized.rows[0]
    expect(row.memoryType).toBe('labour')
    expect(row.labourHours).toBe('8')
    expect(row.labourPerson).toBe('Tom')
    expect(row.itemLabel).toBe('electrics') // labourTask fallback
  })
})

// ── Memory-view labour cost summary ───────────────────────────────────────────

describe('memory-view — labour cost summary', () => {
  const MV = `/api/jobs/${JOB_ID}/memory-view`

  it('reports included labour, hours-only as no_rate_or_cost, and totalKnownCost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'ord', totalCostAmount: '100', costCurrency: 'GBP' }),
      makeMemory({ id: 'paid', memoryType: 'LABOUR', materialName: null, labourTask: 'roof', totalCostAmount: '600', costCurrency: 'GBP' }),
      makeMemory({ id: 'hours', memoryType: 'LABOUR', materialName: null, labourHours: '6', labourTask: 'cladding', totalCostAmount: null, costCurrency: null }),
    ])
    const res = await app.inject({ method: 'GET', url: MV, headers })
    const cs = res.json<{ costSummary: {
      labour: { knownSpendAmount: string | null; rows: Array<{ memoryItemId: string }>; excludedRows: Array<{ memoryItemId: string; reason: string }> }
      totalKnownCost: { knownSpendAmount: string | null; includedMemoryItemIds: string[] }
    } }>().costSummary

    expect(cs.labour.knownSpendAmount).toBe('600')
    expect(cs.labour.rows.map((r) => r.memoryItemId)).toEqual(['paid'])
    expect(cs.labour.excludedRows).toEqual([
      expect.objectContaining({ memoryItemId: 'hours', reason: 'no_rate_or_cost' }),
    ])
    expect(cs.totalKnownCost.knownSpendAmount).toBe('700') // 100 material + 600 labour
    expect([...cs.totalKnownCost.includedMemoryItemIds].sort()).toEqual(['ord', 'paid'])
  })

  it('classifies ambiguous labour cost as cost_worth_checking', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      // rate stated but no hours → no safe total → worth checking
      makeMemory({ id: 'rate', memoryType: 'LABOUR', materialName: null, labourTask: 'electrics', costAmount: '35', costQualifier: 'per_hour', totalCostAmount: null, costCurrency: 'GBP' }),
    ])
    const res = await app.inject({ method: 'GET', url: MV, headers })
    const labour = res.json<{ costSummary: { labour: { excludedRows: Array<{ reason: string }> } } }>().costSummary.labour
    expect(labour.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('exposes a labour section with labour fields on items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemory({ id: 'l1', memoryType: 'LABOUR', materialName: null, labourHours: '6', labourPerson: 'Tom', labourTask: 'cladding', totalCostAmount: null, costCurrency: null }),
    ])
    const res = await app.inject({ method: 'GET', url: MV, headers })
    const section = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>().sections.find((s) => s.key === 'labour')
    expect(section?.items).toHaveLength(1)
    expect(section?.items[0].labourHours).toBe('6')
    expect(section?.items[0].labourTask).toBe('cladding')
  })
})

// ── Memory-item labour edits ──────────────────────────────────────────────────

describe('memory-items — labour edits', () => {
  const MI = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}`

  it('full edit to labour persists labour fields and derives a per_hour total', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: MI, headers, payload: {
      memoryType: 'labour', summary: 'Tom 8h electrics at £35/hr', materialName: null,
      labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics', costAmount: '35', costCurrency: 'GBP', costQualifier: 'per_hour',
    } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data.memoryType).toBe('LABOUR')
    expect(call.data.labourHours).toBe('8')
    expect(call.data.totalCostAmount).toBe('280') // 8 × 35
  })

  it('allows a category on a labour memory item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeMemory({ memoryType: 'LABOUR', materialName: null }))
    vi.mocked(prisma.jobBudgetCategory.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeCategory({ name: 'labour' }))
    const res = await app.inject({ method: 'PATCH', url: MI, headers, payload: { budgetCategoryId: CAT_ID } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Record<string, unknown>>().budgetCategoryId).toBe(CAT_ID)
  })

  it('rejects per_hour as an invalid... no — accepts per_hour costQualifier', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: MI, headers, payload: { memoryType: 'labour', summary: 'x', costQualifier: 'per_hour', costAmount: '35', costCurrency: 'GBP', labourHours: '2' } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.memoryItem.update).mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data.totalCostAmount).toBe('70')
  })
})
