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
