import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'review-user-1'
const OTHER_USER_ID = 'review-other-user'
const JOB_ID = 'review-job-1'
const NOTE_ID = 'review-note-1'
const TRANSCRIPT_ID = 'review-tx-1'
const FACT_ID = 'review-fact-1'
const DECISION_ID = 'review-decision-1'
const MEMORY_ID = 'review-memory-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    audioObject: { create: vi.fn() },
    transcript: {
      create: vi.fn().mockResolvedValue({ id: 'tx-1' }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    candidateFact: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewDecision: {
      create: vi.fn(),
    },
    memoryItem: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

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
    sourceTranscriptId: TRANSCRIPT_ID,
    factType: 'ORDERED_MATERIAL',
    status: 'DRAFT',
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: 'tomorrow morning',
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    confidenceReason: 'Stated explicitly',
    uncertaintyFlags: [],
    extractionProvider: 'fake',
    extractionModel: 'fake-v1',
    extractionSchemaVersion: 'v1',
    createdAt: new Date('2026-06-08T09:00:00Z'),
    updatedAt: new Date('2026-06-08T09:00:00Z'),
    sourceNote: { capturedAt: new Date('2026-06-08T09:00:00Z') },
    transcript: { text: 'Ordered 12 sheets of plasterboard from Jewson.' },
    ...overrides,
  }
}

function makeDecision(overrides?: object) {
  return {
    id: DECISION_ID,
    jobId: JOB_ID,
    decidedBy: USER_ID,
    action: 'CONFIRM',
    candidateFactId: FACT_ID,
    sectionKey: null,
    reason: null,
    createdAt: new Date(),
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
    createdAt: new Date('2026-06-08T09:00:00Z'),
    updatedAt: new Date('2026-06-08T09:00:00Z'),
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

  vi.mocked(prisma.user.findUnique as any).mockResolvedValue({
    id: USER_ID, email: 'test@review.local', name: 'Test', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValue(null)
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue(makeDecision())
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    ...makeMemoryItem(),
    ...data,
    id: MEMORY_ID,
    createdAt: new Date('2026-06-08T09:00:00Z'),
    updatedAt: new Date('2026-06-08T09:00:00Z'),
  }))
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.update as any).mockResolvedValue({})
})

// ─── GET /review-draft ───────────────────────────────────────────────────────

describe('GET /api/jobs/:jobId/review-draft', () => {
  it('returns grouped draft with all section keys', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-draft`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json.jobId).toBe(JOB_ID)
    expect(json.groups).toHaveLength(7)
    const keys = json.groups.map((g: any) => g.key)
    expect(keys).toContain('ordered_materials')
    expect(keys).toContain('unclear_items')
  })

  it('places a DRAFT ORDERED_MATERIAL fact in ordered_materials group', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([makeFact()])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-draft`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const json = response.json()
    const group = json.groups.find((g: any) => g.key === 'ordered_materials')
    expect(group.items).toHaveLength(1)
    expect(group.items[0].candidateFact.factType).toBe('ordered_material')
    expect(group.items[0].candidateFact.status).toBe('draft')
  })

  it('includes source context with transcript text', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([makeFact()])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-draft`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const json = response.json()
    const item = json.groups.find((g: any) => g.key === 'ordered_materials').items[0]
    expect(item.source.noteId).toBe(NOTE_ID)
    expect(item.source.transcriptId).toBe(TRANSCRIPT_ID)
    expect(item.source.capturedAt).toBeDefined()
    expect(item.source.transcriptText).toBe('Ordered 12 sheets of plasterboard from Jewson.')
  })

  it('places UNCLEAR fact in unclear_items group', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([
      makeFact({ factType: 'UNCLEAR', status: 'UNCLEAR' }),
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-draft`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    const json = response.json()
    const unclearGroup = json.groups.find((g: any) => g.key === 'unclear_items')
    expect(unclearGroup.items).toHaveLength(1)
    const orderedGroup = json.groups.find((g: any) => g.key === 'ordered_materials')
    expect(orderedGroup.items).toHaveLength(0)
  })

  it('returns 404 for unknown job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce(null)

    const response = await app.inject({
      method: 'GET',
      url: '/api/jobs/no-such-job/review-draft',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 403 for a job owned by another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce(makeJob({ ownerUserId: OTHER_USER_ID }))

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/review-draft`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(403)
  })
})

// ─── POST confirm ────────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — confirm', () => {
  it('returns confirmed candidateFact and memoryItem', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.action).toBe('confirm')
    expect(json.candidateFact).toMatchObject({ id: FACT_ID, status: 'confirmed' })
    expect(json.memoryItem).toBeDefined()
    expect(json.memoryItem.memoryType).toBe('ordered_material')
    expect(json.memoryItem.isManual).toBe(false)
    expect(json.memoryItem.sourceCandidateFactId).toBe(FACT_ID)
  })

  it('creates a memory item with correct fields from the candidate fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(vi.mocked(prisma.memoryItem.create as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobId: JOB_ID,
          sourceCandidateFactId: FACT_ID,
          memoryType: 'ORDERED_MATERIAL',
          summary: 'Ordered 12 sheets of plasterboard from Jewson',
          isManual: false,
        }),
      }),
    )
  })

  it('marks candidateFact as CONFIRMED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(vi.mocked(prisma.candidateFact.update as any)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CONFIRMED' } }),
    )
  })

  it('returns 409 when confirming an UNCLEAR fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ status: 'UNCLEAR' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'ALREADY_REVIEWED' })
  })

  it('returns 409 when candidate is already CONFIRMED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ status: 'CONFIRMED' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'ALREADY_REVIEWED' })
  })

  it('returns 404 when candidate fact does not exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(null)

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: 'no-such-fact' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'CANDIDATE_FACT_NOT_FOUND' })
  })
})

// ─── POST correct ────────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — correct', () => {
  it('creates memory item from corrected fields, not original', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'correct',
        candidateFactId: FACT_ID,
        corrected: {
          summary: 'Used 10 sheets of plasterboard on the ceiling',
          materialName: 'plasterboard',
          quantity: '10',
          unit: 'sheets',
          supplierName: null,
          deliveryTiming: null,
          locationOrUse: 'ceiling',
        },
      },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.action).toBe('correct')
    expect(json.candidateFact).toMatchObject({ id: FACT_ID, status: 'corrected' })
    expect(json.memoryItem.summary).toBe('Used 10 sheets of plasterboard on the ceiling')
    expect(json.memoryItem.locationOrUse).toBe('ceiling')
    expect(json.memoryItem.sourceCandidateFactId).toBe(FACT_ID)
  })

  it('marks candidateFact as CORRECTED (not deleted — original preserved)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'correct',
        candidateFactId: FACT_ID,
        corrected: { summary: 'Corrected summary' },
      },
    })

    expect(vi.mocked(prisma.candidateFact.update as any)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CORRECTED' } }),
    )
  })

  it('can correct an UNCLEAR fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ factType: 'UNCLEAR', status: 'UNCLEAR' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'correct',
        candidateFactId: FACT_ID,
        corrected: { summary: 'Actually this was a used material', locationOrUse: 'kitchen wall' },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().action).toBe('correct')
  })

  it('returns 409 when candidate is already CORRECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ status: 'CORRECTED' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'correct',
        candidateFactId: FACT_ID,
        corrected: { summary: 'Changed again' },
      },
    })

    expect(response.statusCode).toBe(409)
  })
})

// ─── POST reject ─────────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — reject', () => {
  it('marks candidateFact REJECTED and creates no memory item', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(makeFact())

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'reject', candidateFactId: FACT_ID, reason: 'wrong material' },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.action).toBe('reject')
    expect(json.candidateFact).toMatchObject({ id: FACT_ID, status: 'rejected' })
    expect(json.memoryItem).toBeUndefined()
    expect(vi.mocked(prisma.memoryItem.create as any)).not.toHaveBeenCalled()
  })

  it('can reject an UNCLEAR fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ factType: 'UNCLEAR', status: 'UNCLEAR' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'reject', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().candidateFact.status).toBe('rejected')
  })

  it('returns 409 when candidate is already REJECTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ status: 'REJECTED' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'reject', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(409)
  })
})

// ─── POST confirm_section ────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — confirm_section', () => {
  it('confirms all valid DRAFT facts in the section', async () => {
    const { prisma } = await import('../src/db/client.js')
    const f1 = makeFact({ id: 'fact-s1' })
    const f2 = makeFact({ id: 'fact-s2' })
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([f1, f2])

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'ordered_materials',
        candidateFactIds: ['fact-s1', 'fact-s2'],
      },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.action).toBe('confirm_section')
    expect(json.sectionKey).toBe('ordered_materials')
    expect(json.confirmed).toHaveLength(2)
    expect(json.skipped).toHaveLength(0)
  })

  it('skips already-reviewed facts and reports them', async () => {
    const { prisma } = await import('../src/db/client.js')
    const goodFact = makeFact({ id: 'fact-good' })
    const doneFactt = makeFact({ id: 'fact-done', status: 'CONFIRMED' })
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([goodFact, doneFactt])

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'ordered_materials',
        candidateFactIds: ['fact-good', 'fact-done'],
      },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.confirmed).toHaveLength(1)
    expect(json.confirmed[0].candidateFactId).toBe('fact-good')
    expect(json.skipped).toHaveLength(1)
    expect(json.skipped[0]).toMatchObject({ candidateFactId: 'fact-done', reason: 'already_reviewed' })
  })

  it('skips UNCLEAR facts in section confirm', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([
      makeFact({ id: 'fact-u', factType: 'UNCLEAR', status: 'UNCLEAR' }),
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'ordered_materials',
        candidateFactIds: ['fact-u'],
      },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.confirmed).toHaveLength(0)
    expect(json.skipped[0]).toMatchObject({ reason: 'unclear' })
    expect(vi.mocked(prisma.memoryItem.create as any)).not.toHaveBeenCalled()
  })

  it('skips facts from the wrong section', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([
      makeFact({ id: 'fact-x', factType: 'USED_MATERIAL' }),
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'ordered_materials',
        candidateFactIds: ['fact-x'],
      },
    })

    const json = response.json()
    expect(json.skipped[0]).toMatchObject({ reason: 'wrong_section' })
  })

  it('skips facts not found in the job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'ordered_materials',
        candidateFactIds: ['ghost-fact'],
      },
    })

    const json = response.json()
    expect(json.skipped[0]).toMatchObject({ candidateFactId: 'ghost-fact', reason: 'not_found' })
  })

  it('returns 400 for unknown sectionKey', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'confirm_section',
        sectionKey: 'invented_section',
        candidateFactIds: ['fact-1'],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })
})

// ─── POST add_missing ────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — add_missing', () => {
  it('creates a manual memory item with no source candidate fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.create as any).mockResolvedValueOnce(
      makeMemoryItem({
        sourceCandidateFactId: null,
        isManual: true,
        memoryType: 'USED_MATERIAL',
        summary: 'Used 6 sheets of OSB on the back wall',
        materialName: 'OSB',
        quantity: '6',
        unit: 'sheets',
        locationOrUse: 'back wall',
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'add_missing',
        memoryType: 'used_material',
        memory: {
          summary: 'Used 6 sheets of OSB on the back wall',
          materialName: 'OSB',
          quantity: '6',
          unit: 'sheets',
          supplierName: null,
          deliveryTiming: null,
          locationOrUse: 'back wall',
        },
      },
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json.action).toBe('add_missing')
    expect(json.memoryItem).toBeDefined()
    expect(json.memoryItem.isManual).toBe(true)
    expect(json.memoryItem.sourceCandidateFactId).toBeNull()
    expect(json.memoryItem.memoryType).toBe('used_material')
  })

  it('creates MemoryItem with isManual: true and no sourceCandidateFactId', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'add_missing',
        memoryType: 'used_material',
        memory: { summary: 'Something manual' },
      },
    })

    expect(vi.mocked(prisma.memoryItem.create as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isManual: true,
          sourceCandidateFactId: null,
          memoryType: 'USED_MATERIAL',
        }),
      }),
    )
  })

  it('does not touch candidateFact table', async () => {
    const { prisma } = await import('../src/db/client.js')

    await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {
        action: 'add_missing',
        memoryType: 'watch_out',
        memory: { summary: 'Noted a safety hazard near the window' },
      },
    })

    expect(vi.mocked(prisma.candidateFact.update as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.candidateFact.findUnique as any)).not.toHaveBeenCalled()
  })
})

// ─── GET /memory ─────────────────────────────────────────────────────────────

describe('GET /api/jobs/:jobId/memory', () => {
  it('returns empty array when no memory items exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/memory`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('returns memory items with correct API shape', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValueOnce([makeMemoryItem()])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/memory`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({
      id: MEMORY_ID,
      jobId: JOB_ID,
      memoryType: 'ordered_material',
      isManual: false,
      summary: 'Ordered 12 sheets of plasterboard from Jewson',
      sourceCandidateFactId: FACT_ID,
    })
  })

  it('does not include draft candidate facts in memory', async () => {
    const { prisma } = await import('../src/db/client.js')
    // Memory endpoint queries memoryItem only — candidateFact.findMany not called
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/memory`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    // No candidateFact queries made
    expect(vi.mocked(prisma.candidateFact.findMany as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.candidateFact.findUnique as any)).not.toHaveBeenCalled()
  })

  it('returns 403 for a job owned by another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce(makeJob({ ownerUserId: OTHER_USER_ID }))

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/memory`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(403)
  })
})

// ─── Access control ───────────────────────────────────────────────────────────

describe('POST /api/jobs/:jobId/review-decisions — access control', () => {
  it('returns 403 when job belongs to another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce(makeJob({ ownerUserId: OTHER_USER_ID }))

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(403)
  })

  it('returns 404 for candidate fact belonging to a different job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findUnique as any).mockResolvedValueOnce(
      makeFact({ jobId: 'other-job' }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-decisions`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { action: 'confirm', candidateFactId: FACT_ID },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'CANDIDATE_FACT_NOT_FOUND' })
  })
})

// ─── Input validation ─────────────────────────────────────────────────────────

function post400(body: object) {
  return app.inject({
    method: 'POST',
    url: `/api/jobs/${JOB_ID}/review-decisions`,
    headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
    payload: body,
  })
}

describe('POST /api/jobs/:jobId/review-decisions — input validation', () => {
  it('returns 400 when action is missing', async () => {
    const res = await post400({})
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 for unknown action', async () => {
    const res = await post400({ action: 'do_something_weird' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('confirm: returns 400 when candidateFactId is missing', async () => {
    const res = await post400({ action: 'confirm' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('candidateFactId') })
  })

  it('correct: returns 400 when candidateFactId is missing', async () => {
    const res = await post400({ action: 'correct', corrected: { summary: 'ok' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('candidateFactId') })
  })

  it('correct: returns 400 when corrected is missing', async () => {
    const res = await post400({ action: 'correct', candidateFactId: FACT_ID })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('corrected.summary') })
  })

  it('correct: returns 400 when corrected.summary is missing', async () => {
    const res = await post400({ action: 'correct', candidateFactId: FACT_ID, corrected: { locationOrUse: 'ceiling' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('corrected.summary') })
  })

  it('reject: returns 400 when candidateFactId is missing', async () => {
    const res = await post400({ action: 'reject' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('candidateFactId') })
  })

  it('confirm_section: returns 400 when sectionKey is missing', async () => {
    const res = await post400({ action: 'confirm_section', candidateFactIds: [FACT_ID] })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('sectionKey') })
  })

  it('confirm_section: returns 400 when candidateFactIds is missing', async () => {
    const res = await post400({ action: 'confirm_section', sectionKey: 'ordered_materials' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('candidateFactIds') })
  })

  it('confirm_section: returns 400 when candidateFactIds is an empty array', async () => {
    const res = await post400({ action: 'confirm_section', sectionKey: 'ordered_materials', candidateFactIds: [] })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('candidateFactIds') })
  })

  it('add_missing: returns 400 when memoryType is missing', async () => {
    const res = await post400({ action: 'add_missing', memory: { summary: 'ok' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('memoryType') })
  })

  it('add_missing: returns 400 when memory is missing', async () => {
    const res = await post400({ action: 'add_missing', memoryType: 'used_material' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('memory') })
  })

  it('add_missing: returns 400 when memory.summary is missing', async () => {
    const res = await post400({ action: 'add_missing', memoryType: 'used_material', memory: { materialName: 'OSB' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD', message: expect.stringContaining('memory.summary') })
  })
})
