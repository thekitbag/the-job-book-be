import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'queue-user-1'
const OTHER_USER_ID = 'queue-other-user'
const JOB_ID = 'queue-job-1'
const NOTE_ID = 'queue-note-1'
const NOTE_ID_2 = 'queue-note-2'
const TX_ID = 'queue-tx-1'
const TX_ID_2 = 'queue-tx-2'
const FACT_ID = 'queue-fact-1'
const FACT_ID_2 = 'queue-fact-2'
const ITEM_ID = 'queue-item-1'
const DECISION_ID = 'queue-decision-1'
const MEMORY_ID = 'queue-memory-1'

// Fixed "now" so time labels are deterministic in tests
const NOW = new Date('2026-06-10T12:00:00.000Z')
const TODAY_CAPTURE = new Date('2026-06-10T09:00:00.000Z')
const YESTERDAY_CAPTURE = new Date('2026-06-09T09:00:00.000Z')
const OLDER_CAPTURE = new Date('2026-06-05T09:00:00.000Z')

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    audioObject: { create: vi.fn() },
    transcript: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    candidateFact: { findMany: vi.fn(), updateMany: vi.fn() },
    reviewDecision: { create: vi.fn() },
    memoryItem: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    queueItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

function makeUser(overrides?: object) {
  return {
    id: USER_ID,
    email: 'pilot@test.local',
    name: 'Pilot',
    role: 'PILOT',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeJob(overrides?: object) {
  return {
    id: JOB_ID,
    ownerUserId: USER_ID,
    title: 'Garden Room Build',
    jobType: 'construction',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TX_ID,
    factType: 'USED_MATERIAL',
    status: 'DRAFT',
    summary: 'Used OSB boards on the back wall',
    materialName: 'OSB',
    quantity: '6',
    unit: 'boards',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: 'back wall',
    confidenceLabel: 'MEDIUM',
    confidenceReason: 'Clear from context',
    uncertaintyFlags: [],
    extractionProvider: 'fake',
    extractionModel: null,
    extractionSchemaVersion: null,
    createdAt: TODAY_CAPTURE,
    updatedAt: TODAY_CAPTURE,
    sourceNote: { id: NOTE_ID, capturedAt: TODAY_CAPTURE },
    transcript: { id: TX_ID, text: 'Used six OSB boards on the back wall.' },
    ...overrides,
  }
}

function makeFact2(overrides?: object) {
  return {
    id: FACT_ID_2,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID_2,
    sourceTranscriptId: TX_ID_2,
    factType: 'USED_MATERIAL',
    status: 'DRAFT',
    summary: 'Put OSB on back wall',
    materialName: 'OSB',
    quantity: '6',
    unit: 'boards',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: 'back wall',
    confidenceLabel: 'MEDIUM',
    confidenceReason: 'Clear from context',
    uncertaintyFlags: [],
    extractionProvider: 'fake',
    extractionModel: null,
    extractionSchemaVersion: null,
    createdAt: TODAY_CAPTURE,
    updatedAt: TODAY_CAPTURE,
    sourceNote: { id: NOTE_ID_2, capturedAt: TODAY_CAPTURE },
    transcript: { id: TX_ID_2, text: 'Put OSB on back wall.' },
    ...overrides,
  }
}

function makeQueueItem(overrides?: object) {
  return {
    id: ITEM_ID,
    jobId: JOB_ID,
    sectionKey: 'used_materials',
    kind: 'SINGLE',
    status: 'draft',
    reviewLabel: '',
    timeLabel: 'Today',
    summary: 'Used OSB boards on the back wall',
    proposedMemory: {
      memoryType: 'used_material',
      summary: 'Used OSB boards on the back wall',
      materialName: 'OSB',
      quantity: '6',
      unit: 'boards',
      supplierName: null,
      deliveryTiming: null,
      locationOrUse: 'back wall',
    },
    confidenceLabel: 'medium',
    uncertaintyFlags: [],
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeMemoryItem(overrides?: object) {
  return {
    id: MEMORY_ID,
    jobId: JOB_ID,
    reviewDecisionId: DECISION_ID,
    sourceCandidateFactId: FACT_ID,
    memoryType: 'USED_MATERIAL',
    isManual: false,
    summary: 'Used OSB boards on the back wall',
    materialName: 'OSB',
    quantity: '6',
    unit: 'boards',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: 'back wall',
    createdAt: TODAY_CAPTURE,
    updatedAt: TODAY_CAPTURE,
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

afterAll(() => app.close())

beforeEach(async () => {
  vi.clearAllMocks()

  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.updateMany as any).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.queueItem.deleteMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.queueItem.update as any).mockResolvedValue({})
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue({ id: DECISION_ID })
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    ...makeMemoryItem(),
    ...data,
    id: MEMORY_ID,
  }))
})

// ── GET /api/jobs/:jobId/review-queue ─────────────────────────────────────────

describe('GET /api/jobs/:jobId/review-queue', () => {
  it('returns empty queue when no unresolved facts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.jobId).toBe(JOB_ID)
    expect(body.generatedAt).toBeDefined()
    expect(body.sections).toHaveLength(7)
    const totalItems = body.sections.reduce((n: number, s: any) => n + s.items.length, 0)
    expect(totalItems).toBe(0)
    expect(body.alreadyRemembered).toEqual([])
  })

  it('creates a single item for one DRAFT fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeQueueItem()])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const usedSection = body.sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items).toHaveLength(1)
    expect(usedSection.items[0].kind).toBe('single')
    expect(usedSection.items[0].status).toBe('draft')
    expect(usedSection.items[0].sourceCandidateFactIds).toEqual([FACT_ID])
  })

  it('item includes sourceContext with noteId, transcriptId, capturedAt, transcriptText', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeQueueItem()])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.sourceContext).toHaveLength(1)
    expect(item.sourceContext[0]).toMatchObject({
      candidateFactId: FACT_ID,
      noteId: NOTE_ID,
      transcriptId: TX_ID,
      transcriptText: 'Used six OSB boards on the back wall.',
    })
    expect(item.sourceContext[0].capturedAt).toBeDefined()
  })

  it('groups two same-name same-quantity facts as duplicate_group', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact(), makeFact2()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ kind: 'DUPLICATE_GROUP', reviewLabel: 'Looks like the same item', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    // Verify the grouping service passed a DUPLICATE_GROUP item to createMany
    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'DUPLICATE_GROUP')).toBe(true)

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.kind).toBe('duplicate_group')
    expect(item.reviewLabel).toBe('Looks like the same item')
    expect(item.sourceCandidateFactIds).toEqual([FACT_ID, FACT_ID_2])
  })

  it('groups same-name conflicting-quantity facts as contradiction', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
      makeFact({ quantity: '6' }),
      makeFact2({ quantity: '12' }),
    ])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ kind: 'CONTRADICTION', reviewLabel: 'Worth checking' }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'CONTRADICTION')).toBe(true)

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.kind).toBe('contradiction')
    expect(item.reviewLabel).toBe('Worth checking')
  })

  it('places UNCLEAR fact in unclear_items section as unclear_prompt', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
      makeFact({ factType: 'UNCLEAR', materialName: null, quantity: null }),
    ])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ sectionKey: 'unclear_items', kind: 'UNCLEAR_PROMPT', reviewLabel: 'Needs clarification' }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'UNCLEAR_PROMPT')).toBe(true)

    const unclearSection = res.json().sections.find((s: any) => s.key === 'unclear_items')
    expect(unclearSection.items[0].kind).toBe('unclear_prompt')
  })

  it('assigns Today/Yesterday/Earlier time labels from capturedAt', async () => {
    vi.useFakeTimers({ now: NOW })
    try {
      const { prisma } = await import('../src/db/client.js')
      vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
        makeFact({ sourceNote: { id: NOTE_ID, capturedAt: TODAY_CAPTURE } }),
      ])
      vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
        makeQueueItem({ timeLabel: 'Today' }),
      ])

      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${JOB_ID}/review-queue`,
        headers: { 'x-pilot-user-id': USER_ID },
      })

      // Verify the service computed timeLabel='Today' when passing to createMany
      const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
      expect(callData[0]?.timeLabel).toBe('Today')

      const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
      expect(item.timeLabel).toBe('Today')
    } finally {
      vi.useRealTimers()
    }
  })

  it('deleteMany targets only stale DRAFT items, not decided items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const deleteCall = vi.mocked(prisma.queueItem.deleteMany as any).mock.calls[0]?.[0]
    expect(deleteCall.where.jobId).toBe(JOB_ID)
    expect(deleteCall.where.status).toBe('draft')
    // notIn constraint means decided (non-draft) items are never touched
    expect(deleteCall.where.id).toHaveProperty('notIn')
  })

  it('includes alreadyRemembered memory items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([makeMemoryItem()])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.alreadyRemembered).toHaveLength(1)
    expect(body.alreadyRemembered[0]).toMatchObject({
      memoryItemId: MEMORY_ID,
      summary: 'Used OSB boards on the back wall',
      memoryType: 'used_material',
    })
    expect(body.alreadyRemembered[0].timeLabel).toBeDefined()
  })

  it('alreadyRemembered includes structured fields for frontend display', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemoryItem({
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '30',
        sourceFact: { uncertaintyFlags: ['cost_uncertain'] },
      }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const item = res.json().alreadyRemembered[0]
    expect(item.materialName).toBe('OSB')
    expect(item.quantity).toBe('6')
    expect(item.unit).toBe('boards')
    expect(item.locationOrUse).toBe('back wall')
    expect(item.costAmount).toBe('5')
    expect(item.costCurrency).toBe('GBP')
    expect(item.costQualifier).toBe('each')
    expect(item.totalCostAmount).toBe('30')
    expect(item.uncertaintyFlags).toEqual(['cost_uncertain'])
  })

  it('item ID is stable: createMany receives the same deterministic ID on consecutive GETs', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    // First GET
    await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const firstId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data?.[0]?.id

    // Second GET (simulating a concurrent refresh or page reload)
    await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const secondId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[1]?.[0]?.data?.[0]?.id

    expect(firstId).toBeDefined()
    expect(firstId).toBe(secondId)
  })

  it('decision submitted with ID from first GET succeeds after a second GET runs', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    // First GET — capture the stable ID the service would pass to createMany
    await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const stableId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data?.[0]?.id
    expect(stableId).toBeDefined()

    // Second GET happens on another device before Mike submits his decision
    await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })

    // Decision using the ID from the first GET — findFirst finds the item (stable ID persists)
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem({ id: stableId }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: stableId, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().queueItemId).toBe(stableId)
  })

  it('returns 404 when job not found', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 403 for another user job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-queue`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(403)
  })
})

// ── POST /api/jobs/:jobId/review-queue-decisions ──────────────────────────────

describe('POST /api/jobs/:jobId/review-queue-decisions', () => {
  it('returns 400 when queueItemId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { action: 'confirm' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when action is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when action is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'reject' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when correct missing corrected.summary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'used_material' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when correct missing corrected.memoryType', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'correct', corrected: { summary: 'Some summary' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.memoryType is unclear', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'unclear', summary: 'Some summary' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.memoryType is unknown', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'banana', summary: 'Some summary' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 404 when queue item not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: 'nonexistent', action: 'confirm' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_NOT_FOUND' })
  })

  it('returns 409 when item already decided', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem({ status: 'confirmed' }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_ALREADY_DECIDED' })
  })

  it('returns 409 when confirming a contradiction item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'CONTRADICTION', status: 'draft' }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_CONFIRM_NOT_ALLOWED' })
  })

  it('returns 409 when confirming an unclear_prompt item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'UNCLEAR_PROMPT', status: 'draft' }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_CONFIRM_NOT_ALLOWED' })
  })

  it('confirm: creates memory from proposedMemory and marks source facts CONFIRMED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('confirm')
    expect(body.status).toBe('confirmed')
    expect(body.memoryItemId).toBe(MEMORY_ID)
    expect(body.sourceCandidateFactIds).toEqual([FACT_ID])

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'QUEUE_CONFIRM', jobId: JOB_ID }) }),
    )
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memoryType: 'USED_MATERIAL', summary: 'Used OSB boards on the back wall' }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CONFIRMED' },
    })
  })

  it('confirm: groups with multiple source facts update all of them', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().sourceCandidateFactIds).toEqual([FACT_ID, FACT_ID_2])
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID, FACT_ID_2] } },
      data: { status: 'CONFIRMED' },
    })
  })

  it('correct: creates memory with corrected fields and marks facts CORRECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: {
          memoryType: 'used_material',
          summary: 'Used eight OSB boards on the back wall',
          quantity: '8',
        },
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('correct')
    expect(body.status).toBe('corrected')
    expect(body.memoryItemId).toBeDefined()

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'QUEUE_CORRECT' }) }),
    )
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: 'Used eight OSB boards on the back wall',
          quantity: '8',
          memoryType: 'USED_MATERIAL',
        }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CORRECTED' },
    })
  })

  it('confirm on duplicate group preserves both source fact IDs on the review decision', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
        }),
      }),
    )
  })

  it('dismiss on duplicate group preserves both source fact IDs on the review decision', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'dismiss' },
    })

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
        }),
      }),
    )
  })

  it('contradiction can be corrected into memory', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'CONTRADICTION', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: { memoryType: 'used_material', summary: 'Used twelve OSB boards', quantity: '12' },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().action).toBe('correct')
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID, FACT_ID_2] } },
      data: { status: 'CORRECTED' },
    })
  })

  it('dismiss: no memory created, marks facts REJECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'dismiss', reason: 'Not about this job' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('dismiss')
    expect(body.status).toBe('dismissed')
    expect(body.memoryItemId).toBeNull()

    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'QUEUE_DISMISS', reason: 'Not about this job' }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'REJECTED' },
    })
  })

  it('dismiss without reason still succeeds', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'dismiss' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().action).toBe('dismiss')
  })

  it('returns 403 for decision on another user job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── Cost field validation and persistence ─────────────────────────────────────

describe('POST /api/jobs/:jobId/review-queue-decisions — cost field validation', () => {
  it('returns 400 INVALID_FIELD when corrected.costAmount is not a decimal string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: { memoryType: 'ordered_material', summary: 'Some order', costAmount: 'abc' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.totalCostAmount is not a decimal string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: { memoryType: 'ordered_material', summary: 'Some order', totalCostAmount: '£40' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.costQualifier is not a valid qualifier', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: { memoryType: 'ordered_material', summary: 'Some order', costQualifier: 'weekly' },
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('confirm: persists cost fields from proposedMemory to memory item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({
        sectionKey: 'ordered_materials',
        proposedMemory: {
          memoryType: 'ordered_material',
          summary: 'Ordered 8 bags of hardcore from Jewson at £5 each',
          materialName: 'hardcore',
          quantity: '8',
          unit: 'bags',
          supplierName: 'Jewson',
          deliveryTiming: null,
          locationOrUse: null,
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        },
      }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: ITEM_ID, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        }),
      }),
    )
  })

  it('correct: persists cost fields from corrected body to memory item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        queueItemId: ITEM_ID,
        action: 'correct',
        corrected: {
          memoryType: 'ordered_material',
          summary: 'Ordered 8 bags of hardcore at £5 each',
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        }),
      }),
    )
  })
})
