import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'mi-user-1'
const OTHER_USER_ID = 'mi-other-user'
const JOB_ID = 'mi-job-1'
const NOTE_ID = 'mi-note-1'
const TRANSCRIPT_ID = 'mi-tx-1'
const FACT_ID = 'mi-fact-1'
const DECISION_ID = 'mi-decision-1'
const MEMORY_ID = 'mi-memory-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    memoryItem: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    queueItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    reviewDecision: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

function makeJob(overrides?: object) {
  return {
    id: JOB_ID,
    ownerUserId: USER_ID,
    title: 'Test job',
    jobType: 'construction',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeSourceFact(overrides?: object) {
  return {
    id: FACT_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TRANSCRIPT_ID,
    uncertaintyFlags: [],
    sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-20T09:00:00.000Z') },
    transcript: { id: TRANSCRIPT_ID, text: 'Ordered 12 sheets of plasterboard from Jewson' },
    ...overrides,
  }
}

function makeExistingMemoryItem(overrides?: object) {
  return {
    id: MEMORY_ID,
    jobId: JOB_ID,
    reviewDecisionId: DECISION_ID,
    sourceCandidateFactId: FACT_ID,
    memoryType: 'ORDERED_MATERIAL',
    isManual: false,
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: null,
    locationOrUse: null,
    costAmount: null,
    costCurrency: null,
    costQualifier: null,
    totalCostAmount: null,
    unresolvedFlags: [],
    createdAt: new Date('2026-06-20T09:00:00.000Z'),
    updatedAt: new Date('2026-06-20T09:00:00.000Z'),
    ...overrides,
  }
}

function makeUpdatedMemoryItem(overrides?: object) {
  return {
    ...makeExistingMemoryItem(),
    sourceFact: makeSourceFact(),
    ...overrides,
  }
}

const PATCH_URL = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}`

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
})

afterAll(() => app.close())

beforeEach(async () => {
  vi.clearAllMocks()

  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue({
    id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT',
    createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeExistingMemoryItem())
  vi.mocked(prisma.memoryItem.update as any).mockImplementation(async ({ data }: any) =>
    makeUpdatedMemoryItem(data),
  )
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
})

// ── Validation ────────────────────────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — validation', () => {
  it('returns 400 MISSING_FIELD when memoryType is absent', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { quantity: '10' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 INVALID_FIELD when memoryType is unclear', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'unclear' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when memoryType is unknown', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'banana' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when costAmount is not a decimal string', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', costAmount: '5 each' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when totalCostAmount is not a decimal string', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', totalCostAmount: '£40' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when costQualifier is invalid', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', costQualifier: 'weekly' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })
})

// ── Access control ────────────────────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — access control', () => {
  it('returns 403 when job belongs to another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns 404 when job does not exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 404 when memory item does not exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'MEMORY_ITEM_NOT_FOUND' })
  })
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — happy path', () => {
  it('returns 200 with normalized updated memory item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({ quantity: '10', supplierName: "Jews & Sons" }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', quantity: '10', supplierName: "Jews & Sons" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(MEMORY_ID)
    expect(body.memoryType).toBe('ordered_material')
    expect(body.quantity).toBe('10')
    expect(body.supplierName).toBe("Jews & Sons")
  })

  it('persists cost fields when supplied', async () => {
    const { prisma } = await import('../src/db/client.js')

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        memoryType: 'ordered_material',
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '60',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '60',
        }),
      }),
    )
  })

  it('memoryType change is stored in uppercase', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'used_material' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memoryType: 'USED_MATERIAL' }),
      }),
    )
  })

  it('returns normalized lowercase memoryType in response', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({ memoryType: 'USED_MATERIAL' }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'used_material' },
    })

    expect(res.json().memoryType).toBe('used_material')
  })

  it('preserves source linkage in response', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    const body = res.json()
    expect(body.sourceCandidateFactId).toBe(FACT_ID)
    expect(body.reviewDecisionId).toBe(DECISION_ID)
    expect(body.source).not.toBeNull()
    expect(body.source.candidateFactId).toBe(FACT_ID)
    expect(body.source.noteId).toBe(NOTE_ID)
    expect(typeof body.source.transcriptText).toBe('string')
  })

  it('uncertaintyFlags in response comes from unresolvedFlags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({ unresolvedFlags: ['material_uncertain'] }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(res.json().uncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('sourceUncertaintyFlags in response comes from sourceFact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: ['material_uncertain'] }),
      }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(res.json().uncertaintyFlags).toEqual([])
    expect(res.json().sourceUncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('does not modify candidate fact status', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', quantity: '10' },
    })

    expect(prisma.candidateFact.findMany).not.toHaveBeenCalled()
    expect((prisma as any).candidateFact.updateMany).toBeUndefined()
  })

  it('does not create queue items', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', quantity: '10' },
    })

    expect(prisma.queueItem.createMany).not.toHaveBeenCalled()
  })
})

// ── PATCH uncertaintyResolution ───────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — uncertaintyResolution', () => {
  it('returns 400 INVALID_FIELD when uncertaintyResolution is not a valid value', async () => {
    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', uncertaintyResolution: 'maybe' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('resolved clears unresolvedFlags to []', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ unresolvedFlags: ['material_uncertain'] }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', uncertaintyResolution: 'resolved' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: [] }) }),
    )
  })

  it('still_unsure preserves existing unresolvedFlags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ unresolvedFlags: ['material_uncertain'] }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', uncertaintyResolution: 'still_unsure' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: ['material_uncertain'] }) }),
    )
  })

  it('omitting uncertaintyResolution preserves existing unresolvedFlags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ unresolvedFlags: ['approximate_quantity'] }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: ['approximate_quantity'] }) }),
    )
  })
})

// ── POST /verify ──────────────────────────────────────────────────────────────

const VERIFY_URL = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}/verify`

describe('POST /api/jobs/:jobId/memory-items/:memoryItemId/verify', () => {
  it('returns 404 MEMORY_ITEM_NOT_FOUND when item does not exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)

    const res = await app.inject({
      method: 'POST', url: VERIFY_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'MEMORY_ITEM_NOT_FOUND' })
  })

  it('returns 403 when job belongs to another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'POST', url: VERIFY_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('clears unresolvedFlags to [] and returns normalized item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ unresolvedFlags: ['material_uncertain'] }),
    )
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({ unresolvedFlags: [] }),
    )

    const res = await app.inject({
      method: 'POST', url: VERIFY_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unresolvedFlags: [] } }),
    )
    expect(res.json().uncertaintyFlags).toEqual([])
  })

  it('returns normalized shape with source linkage', async () => {
    const res = await app.inject({
      method: 'POST', url: VERIFY_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(MEMORY_ID)
    expect(body.memoryType).toBe('ordered_material')
    expect(body.source).not.toBeNull()
    expect(body.source.candidateFactId).toBe(FACT_ID)
  })

  it('does not mutate candidateFact', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'POST', url: VERIFY_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(prisma.candidateFact.findMany).not.toHaveBeenCalled()
  })
})

// ── PATCH cost recalculation ──────────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation', () => {
  it('auto-derives totalCostAmount from quantity × costAmount when qualifier is each', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: null }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '40' }) }),
    )
  })

  it('re-derives when quantity is updated', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40' }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', quantity: '10' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '50' }) }),
    )
  })

  it('explicit totalCostAmount in patch is used when provided', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: null }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', totalCostAmount: '45' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '45' }) }),
    )
  })

  it('adds cost_uncertain when explicit total conflicts with derived amount', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({ quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', unresolvedFlags: [] }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', totalCostAmount: '45' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unresolvedFlags: expect.arrayContaining(['cost_uncertain']) }),
      }),
    )
  })

  it('removes cost_uncertain when derived total now matches stored total', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({
        quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each',
        totalCostAmount: '45', unresolvedFlags: ['cost_uncertain'],
      }),
    )

    // Patch corrects the quantity so derived = explicit
    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material', quantity: '9', totalCostAmount: '45' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unresolvedFlags: [] }),
      }),
    )
  })

  it('does not derive when qualifier is not each', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(
      makeExistingMemoryItem({
        quantity: '1', costAmount: '600', costCurrency: 'GBP',
        costQualifier: 'total', totalCostAmount: null,
      }),
    )

    await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(prisma.memoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: null }) }),
    )
  })
})

// ── PATCH response labels ─────────────────────────────────────────────────────

describe('PATCH /api/jobs/:jobId/memory-items/:memoryItemId — response labels', () => {
  it('includes unitCostLabel and lineTotalLabel in response', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({
        costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40', unresolvedFlags: [],
      }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(res.json().unitCostLabel).toBe('£5 each')
    expect(res.json().lineTotalLabel).toBe('£40 total')
  })

  it('unitCostLabel is null when qualifier is not each', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.update as any).mockResolvedValue(
      makeUpdatedMemoryItem({
        costAmount: '600', costCurrency: 'GBP', costQualifier: 'total', totalCostAmount: '600', unresolvedFlags: [],
      }),
    )

    const res = await app.inject({
      method: 'PATCH', url: PATCH_URL,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { memoryType: 'ordered_material' },
    })

    expect(res.json().unitCostLabel).toBeNull()
    expect(res.json().lineTotalLabel).toBe('£600 total')
  })
})
