import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'tidy-user-1'
const OTHER_USER_ID = 'tidy-other-user'
const JOB_ID = 'tidy-job-1'
const NOTE_ID = 'tidy-note-1'
const NOTE_ID_2 = 'tidy-note-2'
const TX_ID = 'tidy-tx-1'
const TX_ID_2 = 'tidy-tx-2'
const FACT_ID = 'tidy-fact-1'
const FACT_ID_2 = 'tidy-fact-2'
const RUN_ID = 'tidy-run-1'
const ITEM_ID = 'tidy-item-1'
const ITEM_ID_2 = 'tidy-item-2'
const DECISION_ID = 'tidy-decision-1'
const MEMORY_ID = 'tidy-memory-1'
const LOCAL_DATE = '2026-06-09'

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
    tidyUpRun: { findFirst: vi.fn(), create: vi.fn() },
    tidyUpItem: { findFirst: vi.fn(), findMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn() },
    tidyUpDecision: { create: vi.fn() },
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
    createdAt: new Date(`${LOCAL_DATE}T09:00:00.000Z`),
    updatedAt: new Date(`${LOCAL_DATE}T09:00:00.000Z`),
    sourceNote: { id: NOTE_ID, capturedAt: new Date(`${LOCAL_DATE}T09:00:00.000Z`) },
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
    createdAt: new Date(`${LOCAL_DATE}T14:00:00.000Z`),
    updatedAt: new Date(`${LOCAL_DATE}T14:00:00.000Z`),
    sourceNote: { id: NOTE_ID_2, capturedAt: new Date(`${LOCAL_DATE}T14:00:00.000Z`) },
    transcript: { id: TX_ID_2, text: 'Put OSB on back wall.' },
    ...overrides,
  }
}

function makeTidyUpRun(overrides?: object) {
  return {
    id: RUN_ID,
    jobId: JOB_ID,
    localDate: LOCAL_DATE,
    status: 'ready',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeTidyUpItem(overrides?: object) {
  return {
    id: ITEM_ID,
    tidyUpRunId: RUN_ID,
    jobId: JOB_ID,
    sectionKey: 'used_materials',
    kind: 'SINGLE',
    status: 'DRAFT',
    reviewLabel: '',
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
    reviewDecisionId: null,
    tidyUpDecisionId: DECISION_ID,
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
    createdAt: new Date(),
    updatedAt: new Date(),
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
  vi.mocked(prisma.rawNote.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.updateMany as any).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.tidyUpRun.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.tidyUpRun.create as any).mockResolvedValue(makeTidyUpRun())
  vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([])
  vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.tidyUpItem.update as any).mockResolvedValue({})
  vi.mocked(prisma.tidyUpDecision.create as any).mockResolvedValue({ id: DECISION_ID })
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    ...makeMemoryItem(),
    ...data,
    id: MEMORY_ID,
  }))
  vi.mocked(prisma.memoryItem.update as any).mockResolvedValue({})
})

// ── POST /api/jobs/:jobId/tidy-ups ────────────────────────────────────────────

describe('POST /api/jobs/:jobId/tidy-ups', () => {
  it('returns 400 when localDate is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 404 when job not found', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 403 when job belongs to another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })
    expect(res.statusCode).toBe(403)
  })

  it('creates a run with a single item for one fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    // createOrGetTidyUp calls findMany once (grouping); buildSourceContextMapFromFacts uses
    // in-memory data, so no second findMany call during CREATE.
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([makeTidyUpItem()])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(RUN_ID)
    expect(body.localDate).toBe(LOCAL_DATE)
    expect(body.status).toBe('ready')
    const usedSection = body.sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items).toHaveLength(1)
    expect(usedSection.items[0].kind).toBe('single')
  })

  it('groups two same-name same-quantity facts into a duplicate_group', async () => {
    const { prisma } = await import('../src/db/client.js')
    const fact1 = makeFact()
    const fact2 = makeFact2()

    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([fact1, fact2])
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([
      makeTidyUpItem({ kind: 'DUPLICATE_GROUP', reviewLabel: 'Looks like the same item', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    ])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    // Verify the grouping service produced a DUPLICATE_GROUP item in the createManyAndReturn call
    const callData = vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'DUPLICATE_GROUP')).toBe(true)
    // Also verify the formatted response reflects the returned item kind
    const usedSection = res.json().sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items[0].kind).toBe('duplicate_group')
    expect(usedSection.items[0].reviewLabel).toBe('Looks like the same item')
  })

  it('groups same-name conflicting-quantity facts as contradiction', async () => {
    const { prisma } = await import('../src/db/client.js')
    const fact1 = makeFact({ quantity: '6' })
    const fact2 = makeFact2({ quantity: '12' })

    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([fact1, fact2])
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([
      makeTidyUpItem({ kind: 'CONTRADICTION', reviewLabel: 'Worth checking' }),
    ])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    const callData = vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'CONTRADICTION')).toBe(true)
    const usedSection = res.json().sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items[0].kind).toBe('contradiction')
    expect(usedSection.items[0].reviewLabel).toBe('Worth checking')
  })

  it('places UNCLEAR fact in unclear_items section as unclear_prompt', async () => {
    const { prisma } = await import('../src/db/client.js')
    const unclearFact = makeFact({ factType: 'UNCLEAR' })

    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([unclearFact])
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([
      makeTidyUpItem({ sectionKey: 'unclear_items', kind: 'UNCLEAR_PROMPT', reviewLabel: 'Needs clarification' }),
    ])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    const callData = vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'UNCLEAR_PROMPT')).toBe(true)
    const unclearSection = res.json().sections.find((s: any) => s.key === 'unclear_items')
    expect(unclearSection.items[0].kind).toBe('unclear_prompt')
  })

  it('excludes already-reviewed (CONFIRMED) candidate facts from the run', async () => {
    const { prisma } = await import('../src/db/client.js')
    // findMany returns empty because the service queries status IN ['DRAFT','UNCLEAR']
    // and confirmed facts are excluded at the query level; mock returns empty
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    // All sections empty — no action-required items
    const body = res.json()
    const totalItems = body.sections.reduce((n: number, s: any) => n + s.items.length, 0)
    expect(totalItems).toBe(0)
  })

  it('returns existing run when forceRefresh is false', async () => {
    const { prisma } = await import('../src/db/client.js')
    const existingRun = { ...makeTidyUpRun(), items: [makeTidyUpItem()] }
    vi.mocked(prisma.tidyUpRun.findFirst as any).mockResolvedValue(existingRun)
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(RUN_ID)
    // Should not create a new run
    expect(prisma.tidyUpRun.create).not.toHaveBeenCalled()
  })

  it('creates new run when forceRefresh is true even if existing run present', async () => {
    const { prisma } = await import('../src/db/client.js')
    const newRun = { ...makeTidyUpRun(), id: 'new-run-id' }
    // Even with an existing run, forceRefresh=true skips the findFirst check
    vi.mocked(prisma.tidyUpRun.create as any).mockResolvedValue(newRun)
    vi.mocked(prisma.tidyUpItem.createManyAndReturn as any).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { localDate: LOCAL_DATE, forceRefresh: true },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe('new-run-id')
    expect(prisma.tidyUpRun.create).toHaveBeenCalled()
  })
})

// ── GET /api/jobs/:jobId/tidy-ups/:tidyUpId ───────────────────────────────────

describe('GET /api/jobs/:jobId/tidy-ups/:tidyUpId', () => {
  it('returns tidy-up run with items and sourceContext', async () => {
    const { prisma } = await import('../src/db/client.js')
    const run = { ...makeTidyUpRun(), items: [makeTidyUpItem()] }
    vi.mocked(prisma.tidyUpRun.findFirst as any).mockResolvedValue(run)
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups/${RUN_ID}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(RUN_ID)
    const usedSection = body.sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items).toHaveLength(1)
    expect(usedSection.items[0].sourceContext).toHaveLength(1)
    expect(usedSection.items[0].sourceContext[0]).toMatchObject({
      candidateFactId: FACT_ID,
      noteId: NOTE_ID,
    })
  })

  it('returns 404 when run not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups/nonexistent`,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'TIDY_UP_NOT_FOUND' })
  })

  it('returns 403 for another user job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups/${RUN_ID}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── GET /api/jobs/:jobId/tidy-ups?localDate= ─────────────────────────────────

describe('GET /api/jobs/:jobId/tidy-ups?localDate=', () => {
  it('returns most recent run for date', async () => {
    const { prisma } = await import('../src/db/client.js')
    const run = { ...makeTidyUpRun(), items: [] }
    vi.mocked(prisma.tidyUpRun.findFirst as any).mockResolvedValue(run)
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups?localDate=${LOCAL_DATE}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().localDate).toBe(LOCAL_DATE)
  })

  it('returns 404 when no run for date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups?localDate=${LOCAL_DATE}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'TIDY_UP_NOT_FOUND' })
  })

  it('returns 400 when localDate missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/tidy-ups`,
      headers: { 'x-pilot-user-id': USER_ID },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })
})

// ── POST /api/jobs/:jobId/tidy-up-decisions ───────────────────────────────────

describe('POST /api/jobs/:jobId/tidy-up-decisions', () => {
  it('returns 400 when tidyUpItemId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { action: 'confirm' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when action is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when correct action missing corrected.summary', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(makeTidyUpItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'correct', corrected: {} },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 404 when tidy-up item not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: 'nonexistent', action: 'confirm' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'TIDY_UP_ITEM_NOT_FOUND' })
  })

  it('returns 409 when item already decided', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(
      makeTidyUpItem({ status: 'CONFIRMED' }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'TIDY_UP_ITEM_ALREADY_DECIDED' })
  })

  it('returns 409 when confirming a contradiction item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(
      makeTidyUpItem({ kind: 'CONTRADICTION', status: 'DRAFT' }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'CONTRADICTION_CONFIRM_NOT_ALLOWED' })
  })

  it('confirm: creates memory item and marks source facts CONFIRMED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(makeTidyUpItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('confirm')
    expect(body.status).toBe('confirmed')
    expect(body.memoryItemId).toBe(MEMORY_ID)
    expect(body.sourceCandidateFactIds).toEqual([FACT_ID])

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobId: JOB_ID,
          memoryType: 'USED_MATERIAL',
          summary: 'Used OSB boards on the back wall',
        }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CONFIRMED' },
    })
  })

  it('correct: creates memory item with corrected fields and marks facts CORRECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(makeTidyUpItem())

    const corrected = {
      memoryType: 'used_material',
      summary: 'Used eight OSB boards on the back wall',
      materialName: 'OSB',
      quantity: '8',
      unit: 'boards',
      supplierName: null,
      deliveryTiming: null,
      locationOrUse: 'back wall',
    }

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'correct', corrected },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('correct')
    expect(body.status).toBe('corrected')
    expect(body.memoryItemId).toBeDefined()

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ summary: 'Used eight OSB boards on the back wall', quantity: '8' }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CORRECTED' },
    })
  })

  it('reject: no memory item created, marks facts REJECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(makeTidyUpItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'reject', reason: 'Not relevant' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('reject')
    expect(body.status).toBe('rejected')
    expect(body.memoryItemId).toBeNull()

    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'REJECTED' },
    })
  })

  it('leave_unconfirmed: no memory item, source facts stay unchanged', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(makeTidyUpItem())

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'leave_unconfirmed' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('leave_unconfirmed')
    expect(body.status).toBe('left_unconfirmed')
    expect(body.memoryItemId).toBeNull()

    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
    expect(prisma.candidateFact.updateMany).not.toHaveBeenCalled()
  })

  it('returns 403 for decision on another user job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { tidyUpItemId: ITEM_ID, action: 'confirm' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('contradiction can be corrected into memory', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.tidyUpItem.findFirst as any).mockResolvedValue(
      makeTidyUpItem({
        kind: 'CONTRADICTION',
        status: 'DRAFT',
        sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
      }),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/tidy-up-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: {
        tidyUpItemId: ITEM_ID,
        action: 'correct',
        corrected: { summary: 'Used twelve OSB boards on the back wall', quantity: '12' },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().action).toBe('correct')
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID, FACT_ID_2] } },
      data: { status: 'CORRECTED' },
    })
  })
})
