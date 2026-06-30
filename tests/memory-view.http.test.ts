import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'mv-user-1'
const OTHER_USER_ID = 'mv-other-user'
const JOB_ID = 'mv-job-1'
const NOTE_ID = 'mv-note-1'
const TRANSCRIPT_ID = 'mv-tx-1'
const FACT_ID = 'mv-fact-1'
const DECISION_ID = 'mv-decision-1'
const MEMORY_ID = 'mv-memory-1'
const QUEUE_ITEM_ID = 'mv-qi-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    memoryItem: { findMany: vi.fn() },
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
    title: 'Poole garden room',
    jobType: 'garden_room',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    ...overrides,
  }
}

function makeSourceFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TRANSCRIPT_ID,
    factType: 'ORDERED_MATERIAL',
    status: 'CONFIRMED',
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: 'tomorrow morning',
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    uncertaintyFlags: [],
    createdAt: new Date('2026-06-13T08:55:00.000Z'),
    updatedAt: new Date('2026-06-13T08:55:00.000Z'),
    sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-13T08:55:00.000Z') },
    transcript: {
      id: TRANSCRIPT_ID,
      revision: 1,
      text: 'I ordered 12 sheets of plasterboard from Jewson.',
      status: 'COMPLETED',
      language: 'en',
      provider: 'openai',
      model: 'whisper-1',
      errorCode: null,
      extractionStatus: 'COMPLETED',
      extractionErrorCode: null,
    },
    ...overrides,
  }
}

function makeMemoryItem(overrides?: object) {
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
    deliveryTiming: 'tomorrow morning',
    locationOrUse: null,
    unresolvedFlags: [],
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    sourceFact: makeSourceFact(),
    ...overrides,
  }
}

function makeQueueItem(overrides?: object) {
  return {
    id: QUEUE_ITEM_ID,
    jobId: JOB_ID,
    sectionKey: 'ordered_materials',
    kind: 'SINGLE',
    status: 'draft',
    reviewLabel: '',
    timeLabel: 'Today',
    summary: 'Ordered 6 bricks',
    proposedMemory: {},
    confidenceLabel: 'high',
    uncertaintyFlags: [],
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    ...overrides,
  }
}

// Fact shape expected by buildFreshQueueSections (includes sourceNote + transcript)
function makeQueueFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TRANSCRIPT_ID,
    factType: 'ORDERED_MATERIAL',
    status: 'DRAFT',
    summary: 'Ordered 6 bricks',
    materialName: 'brick',
    quantity: '6',
    unit: null,
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    uncertaintyFlags: [],
    sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-13T09:00:00.000Z') },
    transcript: { id: TRANSCRIPT_ID, text: 'Ordered 6 bricks' },
    ...overrides,
  }
}

const MEMORY_VIEW_URL = `/api/jobs/${JOB_ID}/memory-view`

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
  process.env.PILOT_USER_ID = USER_ID

  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT',
    createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())
  vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMemoryItem()])
  // buildFreshQueueSections defaults: no unresolved facts → empty queue
  vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

describe('GET /api/jobs/:jobId/memory-view — access control', () => {
  it('returns 404 for unknown job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET', url: MEMORY_VIEW_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('JOB_NOT_FOUND')
  })

  it('returns 403 for cross-user job access', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ ownerUserId: OTHER_USER_ID })
    )

    const res = await app.inject({
      method: 'GET', url: MEMORY_VIEW_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN')
  })
})

describe('GET /api/jobs/:jobId/memory-view — response shape', () => {
  const headers = { 'x-pilot-user-id': USER_ID }

  it('returns all six trusted-memory sections', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ sections: Array<{ key: string }> }>()
    const keys = body.sections.map((s) => s.key)
    expect(keys).toEqual([
      'ordered_materials',
      'used_materials',
      'leftovers',
      'supplier_delivery_notes',
      'customer_changes',
      'watch_outs',
    ])
  })

  it('places confirmed memory into the correct section', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: unknown[] }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    const usedMaterials = body.sections.find((s) => s.key === 'used_materials')
    expect(usedMaterials?.items).toHaveLength(0)
  })

  it('shows corrected memory using accepted memory item fields, not original candidate text', async () => {
    const { prisma } = await import('../src/db/client.js')
    // Memory item has corrected values that differ from the source candidate
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        memoryType: 'USED_MATERIAL',
        summary: 'Corrected: used 10 sheets of OSB board',
        materialName: 'OSB board',
        quantity: '10',
        sourceFact: makeSourceFact({
          factType: 'USED_MATERIAL',
          summary: 'Original: plasterboard',
          materialName: 'plasterboard',
        }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<{ summary: string; materialName: string }> }> }>()
    const used = body.sections.find((s) => s.key === 'used_materials')
    expect(used?.items[0].summary).toBe('Corrected: used 10 sheets of OSB board')
    expect(used?.items[0].materialName).toBe('OSB board')
  })

  it('includes budgetCategoryId on section items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ budgetCategoryId: 'cat-timber' }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<{ budgetCategoryId: string | null }> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].budgetCategoryId).toBe('cat-timber')
  })

  it('returns normalized lowercase memoryType and job status', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ job: { status: string }; sections: Array<{ key: string; items: Array<{ memoryType: string }> }> }>()
    expect(body.job.status).toBe('active')
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].memoryType).toBe('ordered_material')
  })

  it('includes source context when sourceCandidateFactId exists', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: Array<{ source: Record<string, unknown> | null }> }> }>()
    const source = body.sections[0].items[0].source
    expect(source).not.toBeNull()
    expect(source!.candidateFactId).toBe(FACT_ID)
    expect(source!.noteId).toBe(NOTE_ID)
    expect(source!.transcriptId).toBe(TRANSCRIPT_ID)
    expect(typeof source!.capturedAt).toBe('string')
    expect(source!.transcriptText).toBe('I ordered 12 sheets of plasterboard from Jewson.')
  })

  it('returns source: null for manual memory with no source fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ sourceCandidateFactId: null, isManual: true, sourceFact: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: Array<{ source: null }> }> }>()
    expect(body.sections[0].items[0].source).toBeNull()
  })

  it('draft candidate facts do not appear in trusted sections', async () => {
    const { prisma } = await import('../src/db/client.js')
    // Only a draft candidate fact exists — no memory items
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeQueueFact({ status: 'DRAFT' }),
    ])
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: unknown[] }> }>()
    const totalItems = body.sections.reduce((sum, s) => sum + s.items.length, 0)
    expect(totalItems).toBe(0)
  })

  it('unresolved draft queue items appear in stillToCheck, not in trusted sections', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeQueueFact({ status: 'DRAFT' }),
    ])
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{
      sections: Array<{ items: unknown[] }>
      stillToCheck: { count: number; items: Array<{ id: string; sectionKey: string; summary: string; kind: string }> }
    }>()
    const totalTrusted = body.sections.reduce((sum, s) => sum + s.items.length, 0)
    expect(totalTrusted).toBe(0)
    expect(body.stillToCheck.count).toBe(1)
    expect(body.stillToCheck.items[0].id).toBe(QUEUE_ITEM_ID)
    expect(body.stillToCheck.items[0].sectionKey).toBe('ordered_materials')
    expect(body.stillToCheck.items[0].kind).toBe('single')
  })

  it('stillToCheck count is 0 when no unresolved work exists', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ stillToCheck: { count: number; items: unknown[] } }>()
    expect(body.stillToCheck.count).toBe(0)
    expect(body.stillToCheck.items).toHaveLength(0)
  })

  it('includes generatedAt timestamp and normalized job summary', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ generatedAt: string; job: { id: string; title: string; jobType: string } }>()
    expect(typeof body.generatedAt).toBe('string')
    expect(body.job.id).toBe(JOB_ID)
    expect(body.job.title).toBe('Poole garden room')
    expect(body.job.jobType).toBe('garden_room')
  })
})

// ── Cost fields and summarySections ──────────────────────────────────────────

describe('GET /api/jobs/:jobId/memory-view — cost fields and summarySections', () => {
  const headers = { 'x-pilot-user-id': USER_ID }

  it('includes cost fields and labels in section items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40' }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].costAmount).toBe('5')
    expect(ordered?.items[0].costCurrency).toBe('GBP')
    expect(ordered?.items[0].costQualifier).toBe('each')
    expect(ordered?.items[0].totalCostAmount).toBe('40')
    expect(ordered?.items[0].unitCostLabel).toBe('£5 each')
    expect(ordered?.items[0].lineTotalLabel).toBe('£40 total')
  })

  it('includes summarySections with correct keys and labels', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; label: string; items: unknown[] }> }>()
    expect(body.summarySections).toHaveLength(3)
    expect(body.summarySections[0]).toMatchObject({ key: 'ordered_materials', label: 'Bought / ordered' })
    expect(body.summarySections[1]).toMatchObject({ key: 'used_materials', label: 'Used' })
    expect(body.summarySections[2]).toMatchObject({ key: 'leftovers', label: 'Leftovers' })
  })

  it('summarySections item has costLabel, totalCostLabel, memoryItemIds, and uncertaintyFlags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '40',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [] }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].costLabel).toBe('£5 each')
    expect(ordered?.items[0].totalCostLabel).toBe('£40 total')
    expect(ordered?.items[0].memoryItemIds).toEqual([MEMORY_ID])
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
  })

  it('summarySections costLabel and totalCostLabel are null when no cost stored', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].costLabel).toBeNull()
    expect(ordered?.items[0].totalCostLabel).toBeNull()
  })

  it('section items uncertaintyFlags come from unresolvedFlags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: ['material_uncertain'], sourceFact: makeSourceFact({ uncertaintyFlags: [] }) }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('section items sourceUncertaintyFlags come from sourceFact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: [], sourceFact: makeSourceFact({ uncertaintyFlags: ['material_uncertain'] }) }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
    expect(ordered?.items[0].sourceUncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('section items have empty uncertaintyFlags and sourceUncertaintyFlags when no sourceFact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: [], sourceCandidateFactId: null, isManual: true, sourceFact: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
    expect(ordered?.items[0].sourceUncertaintyFlags).toEqual([])
  })
})

// ── summarySections consolidation ────────────────────────────────────────────

describe('GET /api/jobs/:jobId/memory-view — summarySections consolidation', () => {
  const headers = { 'x-pilot-user-id': USER_ID }
  const MEMORY_ID_2 = 'mv-memory-2'

  it('consolidates two compatible rows of same materialName + unit into one row', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].quantity).toBe('12')
    expect(ordered?.items[0].memoryItemIds).toEqual(expect.arrayContaining([MEMORY_ID, MEMORY_ID_2]))
    expect((ordered?.items[0].memoryItemIds as string[]).length).toBe(2)
  })

  it('keeps rows separate when units differ (bags vs sheets)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '8',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '4',
        unit: 'sheets',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when any item has unresolved flags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        unresolvedFlags: ['approximate_quantity'],
        sourceFact: makeSourceFact({ uncertaintyFlags: ['approximate_quantity'], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when any quantity is non-numeric', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: 'some',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('merged row nulls out cost labels (items may have different unit costs)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '40',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        costAmount: '6',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '24',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].costLabel).toBeNull()
    expect(ordered?.items[0].totalCostLabel).toBeNull()
  })

  it('keeps rows separate when materialName is null even if unit matches', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: null,
        quantity: '3',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: null,
        quantity: '5',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when unit is null even if materialName matches', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '3',
        unit: null,
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '5',
        unit: null,
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('verified items (empty unresolvedFlags) consolidate even when sourceFact had flags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: ['approximate_quantity'], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].quantity).toBe('12')
  })
})

// ── costSummary ───────────────────────────────────────────────────────────────

describe('GET /api/jobs/:jobId/memory-view — costSummary', () => {
  const headers = { 'x-pilot-user-id': USER_ID }
  const MEMORY_ID_2 = 'mv-memory-2'
  const MEMORY_ID_3 = 'mv-memory-3'

  it('returns costSummary with orderedMaterials key', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: unknown } }>()
    expect(body.costSummary).toBeDefined()
    expect(body.costSummary.orderedMaterials).toBeDefined()
  })

  it('includes a trusted ordered-material item with totalCostAmount and GBP in known spend', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('40')
    expect(om.knownSpendCurrency).toBe('GBP')
    expect(om.knownSpendLabel).toBe('£40 known spend')
    expect(om.includedMemoryItemIds).toEqual([MEMORY_ID])
    expect(om.missingCostCount).toBe(0)
    expect(om.uncertainCostCount).toBe(0)
    expect(om.excludedMemoryItemIds).toEqual([])
  })

  it('sums GBP line totals from multiple trusted items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_2, memoryType: 'ORDERED_MATERIAL', totalCostAmount: '60', costCurrency: 'GBP', unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('100')
    expect(om.knownSpendLabel).toBe('£100 known spend')
  })

  it('excludes item with unresolved flags from known spend as uncertainCost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: ['cost_uncertain'],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.uncertainCostCount).toBe(1)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID)
  })

  it('item with cost_uncertain from unresolvable conflict is excluded from known spend', async () => {
    // Regression: uncertaintyResolution:'resolved' on a conflicting PATCH must not clear cost_uncertain,
    // and any item that still carries cost_uncertain must be excluded here regardless of how it got the flag.
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each',
        totalCostAmount: '45',          // conflicts with 8 × £5 = £40
        unresolvedFlags: ['cost_uncertain'],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const om = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
      .costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.uncertainCostCount).toBe(1)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID)
  })

  it('counts item with no costAmount or totalCostAmount as missingCost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(0)
  })

  it('counts item with costAmount but no totalCostAmount as uncertainCost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: '5', totalCostAmount: null, costQualifier: 'approx', unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.missingCostCount).toBe(0)
    expect(om.uncertainCostCount).toBe(1)
  })

  it('excludes non-ordered-material memory types from costSummary', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'USED_MATERIAL',
        totalCostAmount: '100',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.missingCostCount).toBe(0)
  })

  it('returns knownSpendAmount:null when no trusted ordered-material items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.knownSpendLabel).toBeNull()
    expect(om.rows).toEqual([])
  })

  it('rows include a single trusted item as a row with lineTotalLabel', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        totalCostAmount: '600',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    const rows = body.costSummary.orderedMaterials.rows
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('plasterboard|sheets')
    expect(rows[0].materialName).toBe('plasterboard')
    expect(rows[0].quantity).toBe('12')
    expect(rows[0].unit).toBe('sheets')
    expect(rows[0].lineTotalAmount).toBe('600')
    expect(rows[0].lineTotalCurrency).toBe('GBP')
    expect(rows[0].lineTotalLabel).toBe('£600 total')
    expect(rows[0].memoryItemIds).toEqual([MEMORY_ID])
  })

  it('rows consolidate two like-for-like trusted items (same material + unit)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        totalCostAmount: '20',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>>; knownSpendAmount: string } } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.rows).toHaveLength(1)
    expect(om.rows[0].quantity).toBe('12')
    expect(om.rows[0].lineTotalAmount).toBe('60')
    expect(om.rows[0].lineTotalLabel).toBe('£60 total')
    expect((om.rows[0].memoryItemIds as string[])).toHaveLength(2)
    expect(om.knownSpendAmount).toBe('60')
  })

  it('rows do not consolidate items with different units', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'plasterboard',
        quantity: '8',
        unit: 'bags',
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '4',
        unit: 'sheets',
        totalCostAmount: '80',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    expect(body.costSummary.orderedMaterials.rows).toHaveLength(2)
  })

  it('rows do not consolidate when unit is null', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'hardcore',
        quantity: '8',
        unit: null,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: null,
        totalCostAmount: '20',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    expect(body.costSummary.orderedMaterials.rows).toHaveLength(2)
  })

  it('separate the known spend total from an item with missing cost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_2, memoryType: 'ORDERED_MATERIAL', totalCostAmount: null, costAmount: null, unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_3, memoryType: 'ORDERED_MATERIAL', totalCostAmount: '30', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('40')
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(1)
    expect((om.includedMemoryItemIds as string[])).toEqual([MEMORY_ID])
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID_2)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID_3)
  })
})

// ── costSummary.orderedMaterials.excludedRows ─────────────────────────────────

type ExcludedRow = {
  memoryItemId: string
  itemLabel: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  reason: 'no_cost_remembered' | 'cost_worth_checking'
}

type OrderedMaterials = {
  knownSpendAmount: string | null
  includedMemoryItemIds: string[]
  missingCostCount: number
  uncertainCostCount: number
  excludedMemoryItemIds: string[]
  rows: Array<{ memoryItemIds: string[] }>
  excludedRows: ExcludedRow[]
}

describe('GET /api/jobs/:jobId/memory-view — costSummary.excludedRows', () => {
  const headers = { 'x-pilot-user-id': USER_ID }
  const MEMORY_ID_2 = 'mv-memory-2'
  const MEMORY_ID_3 = 'mv-memory-3'

  async function getOrderedMaterials(): Promise<OrderedMaterials> {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })
    return res.json<{ costSummary: { orderedMaterials: OrderedMaterials } }>()
      .costSummary.orderedMaterials
  }

  it('keeps an included trusted item out of excludedRows', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toEqual([])
    expect(om.rows.flatMap((r) => r.memoryItemIds)).toEqual([MEMORY_ID])
  })

  it('classifies a missing-cost item as no_cost_remembered', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0]).toMatchObject({
      memoryItemId: MEMORY_ID,
      reason: 'no_cost_remembered',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
    })
  })

  it('classifies an ambiguous-basis item (costAmount, no safe total) as cost_worth_checking', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: '5', totalCostAmount: null, costQualifier: 'approx', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('classifies an unresolved-flag item as cost_worth_checking', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('classifies a non-GBP trusted line total as cost_worth_checking', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'EUR', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.knownSpendAmount).toBeNull()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('falls back to summary for itemLabel when materialName is absent', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: null,
        summary: 'Ordered some bits and bobs',
        costAmount: null,
        totalCostAmount: null,
        unresolvedFlags: [],
      }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows[0].itemLabel).toBe('Ordered some bits and bobs')
    expect(om.excludedRows[0].materialName).toBeNull()
  })

  it('uses a safe generic itemLabel when both materialName and summary are blank/whitespace', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: '   ',
        summary: '  \t  ',
        costAmount: null,
        totalCostAmount: null,
        unresolvedFlags: [],
      }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].itemLabel).toBe('Bought item')
    expect((om.excludedRows[0].itemLabel as string).trim().length).toBeGreaterThan(0)
  })

  it('excludes non-ordered-material memory types from excludedRows', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, memoryType: 'USED_MATERIAL', costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toEqual([])
  })

  it('holds set and count invariants on a mixed fixture', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      // included GBP line total
      makeMemoryItem({ id: MEMORY_ID, materialName: 'hardcore', unit: 'bags', totalCostAmount: '404', costCurrency: 'GBP', unresolvedFlags: [] }),
      // missing cost
      makeMemoryItem({ id: MEMORY_ID_2, materialName: 'plasterboard', unit: 'sheets', costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
      // worth checking (unresolved flag)
      makeMemoryItem({ id: MEMORY_ID_3, materialName: 'insulation', unit: 'packs', totalCostAmount: '50', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const om = await getOrderedMaterials()

    // one excluded row per excluded item, with the right reasons
    const byId = Object.fromEntries(om.excludedRows.map((r) => [r.memoryItemId, r.reason]))
    expect(byId[MEMORY_ID_2]).toBe('no_cost_remembered')
    expect(byId[MEMORY_ID_3]).toBe('cost_worth_checking')

    // counts derived from excludedRows
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(1)

    // excludedMemoryItemIds equals the excluded row IDs (order-independent)
    expect([...om.excludedMemoryItemIds].sort()).toEqual([...om.excludedRows.map((r) => r.memoryItemId)].sort())

    // includedMemoryItemIds equals the flattened included row IDs
    expect([...om.includedMemoryItemIds].sort()).toEqual([...om.rows.flatMap((r) => r.memoryItemIds)].sort())

    // every trusted item appears exactly once across rows + excludedRows
    const allIds = [...om.rows.flatMap((r) => r.memoryItemIds), ...om.excludedRows.map((r) => r.memoryItemId)]
    expect(allIds.sort()).toEqual([MEMORY_ID, MEMORY_ID_2, MEMORY_ID_3].sort())
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})
