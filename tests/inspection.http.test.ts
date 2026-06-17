import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'inspect-user-1'
const OTHER_USER_ID = 'inspect-other-user'
const JOB_ID = 'inspect-job-1'
const NOTE_ID = 'inspect-note-1'
const TRANSCRIPT_ID = 'inspect-tx-1'
const FACT_ID = 'inspect-fact-1'
const DECISION_ID = 'inspect-decision-1'
const MEMORY_ID = 'inspect-memory-1'
const QUEUE_ITEM_ID = 'inspect-qi-1'
const FACT_ID_2 = 'inspect-fact-2'
const INSPECTION_KEY = 'test-inspection-key-secret'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: { findMany: vi.fn() },
    reviewDecision: { findMany: vi.fn() },
    memoryItem: { findMany: vi.fn() },
    queueItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    // mocked for auth plugin and other routes in the app
    candidateFact: { findMany: vi.fn() },
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
    createdAt: new Date('2026-06-11T09:00:00.000Z'),
    updatedAt: new Date('2026-06-11T09:00:00.000Z'),
    ...overrides,
  }
}

function makeNote(overrides?: object) {
  return {
    id: NOTE_ID,
    jobId: JOB_ID,
    clientNoteId: 'phone-note-1',
    capturedAt: new Date('2026-06-11T09:15:00.000Z'),
    uploadedAt: new Date('2026-06-11T09:15:08.000Z'),
    serverStatus: 'DONE',
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 18000,
    sizeBytes: 240000,
    audioObject: { id: 'ao-1' },
    transcripts: [makeTranscript()],
    candidateFacts: [makeFact()],
    ...overrides,
  }
}

function makeTranscript(overrides?: object) {
  return {
    id: TRANSCRIPT_ID,
    status: 'COMPLETED',
    text: 'Ordered 12 sheets of plasterboard from Jewson',
    language: 'en',
    provider: 'openai',
    model: 'whisper-1',
    errorCode: null,
    extractionStatus: 'COMPLETED',
    extractionErrorCode: null,
    revision: 1,
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
    status: 'CONFIRMED',
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: null,
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    uncertaintyFlags: [],
    createdAt: new Date('2026-06-11T09:15:30.000Z'),
    updatedAt: new Date('2026-06-11T09:25:00.000Z'),
    ...overrides,
  }
}

function makeDecision(overrides?: object) {
  return {
    id: DECISION_ID,
    jobId: JOB_ID,
    decidedBy: USER_ID,
    action: 'QUEUE_CONFIRM',
    candidateFactId: null,
    sectionKey: 'ordered_materials',
    reason: null,
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date('2026-06-11T09:25:00.000Z'),
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
    deliveryTiming: null,
    locationOrUse: null,
    createdAt: new Date('2026-06-11T09:25:00.000Z'),
    updatedAt: new Date('2026-06-11T09:25:00.000Z'),
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
    reviewLabel: 'Ordered material',
    timeLabel: 'Today',
    summary: 'Ordered 12 sheets of plasterboard',
    proposedMemory: {},
    confidenceLabel: 'high',
    uncertaintyFlags: [],
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date('2026-06-11T09:15:30.000Z'),
    updatedAt: new Date('2026-06-11T09:15:30.000Z'),
    ...overrides,
  }
}

const INSPECTION_URL = `/api/internal/pilot/jobs/${JOB_ID}/inspection`

let app: FastifyInstance
let savedEnv: Record<string, string | undefined>

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

  savedEnv = {
    PILOT_USER_ID: process.env.PILOT_USER_ID,
    INTERNAL_INSPECTION_KEY: process.env.INTERNAL_INSPECTION_KEY,
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  }

  process.env.PILOT_USER_ID = USER_ID
  process.env.INTERNAL_INSPECTION_KEY = INSPECTION_KEY
  process.env.SESSION_COOKIE_SECRET = 'test-inspection-session-secret-32chars!!'
  delete process.env.NODE_ENV

  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())
  vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeNote()])
  vi.mocked(prisma.reviewDecision.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeDecision()])
  vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMemoryItem()])
  // buildFreshQueueSections calls candidateFact.findMany, deleteMany, createMany, then findMany
  vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

describe('GET /api/internal/pilot/jobs/:jobId/inspection — access control', () => {
  it('rejects missing inspection key in production mode', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.INTERNAL_INSPECTION_KEY

    const res = await app.inject({
      method: 'GET',
      url: INSPECTION_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('UNAUTHORIZED')
  })

  it('rejects wrong inspection key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: INSPECTION_URL,
      headers: { 'x-pilot-user-id': USER_ID, 'x-internal-inspection-key': 'wrong-key' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('UNAUTHORIZED')
  })

  it('allows valid inspection key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: INSPECTION_URL,
      headers: { 'x-pilot-user-id': USER_ID, 'x-internal-inspection-key': INSPECTION_KEY },
    })

    expect(res.statusCode).toBe(200)
  })

  it('allows request in dev when no env var is set', async () => {
    delete process.env.INTERNAL_INSPECTION_KEY
    // NODE_ENV is not 'production'

    const res = await app.inject({
      method: 'GET',
      url: INSPECTION_URL,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
  })

  it('enforces job ownership — returns 403 for another users job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ ownerUserId: OTHER_USER_ID })
    )

    const res = await app.inject({
      method: 'GET',
      url: INSPECTION_URL,
      headers: { 'x-pilot-user-id': USER_ID, 'x-internal-inspection-key': INSPECTION_KEY },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN')
  })
})

describe('GET /api/internal/pilot/jobs/:jobId/inspection — response shape', () => {
  const headers = { 'x-pilot-user-id': USER_ID, 'x-internal-inspection-key': INSPECTION_KEY }

  it('includes normalized job summary', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ job: Record<string, unknown>; generatedAt: string }>()
    expect(body.job.id).toBe(JOB_ID)
    expect(body.job.title).toBe('Poole garden room')
    expect(body.job.jobType).toBe('garden_room')
    expect(body.job.status).toBe('active')
    expect(typeof body.generatedAt).toBe('string')
  })

  it('groups notes by UTC day, most recent day first', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({ id: 'note-day1', capturedAt: new Date('2026-06-11T09:00:00.000Z'), transcripts: [], candidateFacts: [] }),
      makeNote({ id: 'note-day2', capturedAt: new Date('2026-06-10T08:00:00.000Z'), transcripts: [], candidateFacts: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ notesByDay: Array<{ localDate: string; notes: unknown[] }> }>()
    expect(body.notesByDay).toHaveLength(2)
    expect(body.notesByDay[0].localDate).toBe('2026-06-11')
    expect(body.notesByDay[1].localDate).toBe('2026-06-10')
  })

  it('includes latest transcript with normalized statuses', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    const body = res.json<{ notesByDay: Array<{ notes: Array<{ transcript: Record<string, unknown>; audioStored: boolean }> }> }>()
    const note = body.notesByDay[0].notes[0]
    expect(note.audioStored).toBe(true)
    expect(note.transcript).not.toBeNull()
    expect(note.transcript!.status).toBe('ready')
    expect(note.transcript!.extractionStatus).toBe('ready')
    expect(note.transcript!.text).toBe('Ordered 12 sheets of plasterboard from Jewson')
    expect(note.transcript!.provider).toBe('openai')
  })

  it('normalizes transcript status: PENDING → waiting, FAILED → failed', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({ transcripts: [makeTranscript({ status: 'PENDING', extractionStatus: null })], candidateFacts: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ notesByDay: Array<{ notes: Array<{ transcript: Record<string, unknown> }> }> }>()
    expect(body.notesByDay[0].notes[0].transcript!.status).toBe('waiting')
    expect(body.notesByDay[0].notes[0].transcript!.extractionStatus).toBeNull()
  })

  it('includes candidate facts with normalized types, statuses, and confidence', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    const body = res.json<{ notesByDay: Array<{ notes: Array<{ candidateFacts: Array<Record<string, unknown>> }> }> }>()
    const fact = body.notesByDay[0].notes[0].candidateFacts[0]
    expect(fact.id).toBe(FACT_ID)
    expect(fact.factType).toBe('ordered_material')
    expect(fact.status).toBe('confirmed')
    expect(fact.confidenceLabel).toBe('high')
    expect(fact.reviewState).toBe('confirmed')
  })

  it('links confirmed facts to decision IDs via sourceCandidateFactIds', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    const body = res.json<{ notesByDay: Array<{ notes: Array<{ candidateFacts: Array<Record<string, unknown>> }> }> }>()
    const fact = body.notesByDay[0].notes[0].candidateFacts[0]
    expect(fact.reviewDecisionIds).toContain(DECISION_ID)
    expect(fact.memoryItemIds).toContain(MEMORY_ID)
  })

  it('maps draft/unclear facts to reviewState waiting', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({ candidateFacts: [makeFact({ status: 'DRAFT', id: 'draft-fact' })] }),
    ])
    vi.mocked(prisma.reviewDecision.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ notesByDay: Array<{ notes: Array<{ candidateFacts: Array<Record<string, unknown>> }> }> }>()
    expect(body.notesByDay[0].notes[0].candidateFacts[0].reviewState).toBe('waiting')
  })

  it('includes current draft queue items grouped by section', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ queue: { sections: Array<{ key: string; label: string; items: unknown[] }> } }>()
    const ordered = body.queue.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered).toBeDefined()
    expect(ordered?.items).toHaveLength(1)
  })

  it('includes trusted memory items with normalized type', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ memoryItems: Array<Record<string, unknown>> }>()
    expect(body.memoryItems).toHaveLength(1)
    expect(body.memoryItems[0].id).toBe(MEMORY_ID)
    expect(body.memoryItems[0].memoryType).toBe('ordered_material')
    expect(body.memoryItems[0].sourceCandidateFactId).toBe(FACT_ID)
    expect(body.memoryItems[0].reviewDecisionId).toBe(DECISION_ID)
  })

  it('includes review decisions with normalized actions', async () => {
    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ reviewDecisions: Array<Record<string, unknown>> }>()
    expect(body.reviewDecisions).toHaveLength(1)
    expect(body.reviewDecisions[0].action).toBe('queue_confirm')
    expect(body.reviewDecisions[0].sourceCandidateFactIds).toContain(FACT_ID)
  })

  it('returns possible miss when transcript is ready but note has no facts', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({
        candidateFacts: [],
        transcripts: [
          makeTranscript({ text: 'Ordered timber from Travis Perkins but nothing was extracted' }),
        ],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ possibleMisses: Array<Record<string, unknown>> }>()
    expect(body.possibleMisses).toHaveLength(1)
    expect(body.possibleMisses[0].noteId).toBe(NOTE_ID)
    expect(typeof body.possibleMisses[0].transcriptExcerpt).toBe('string')
  })

  it('returns no possible miss when transcript has no material-like words', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({
        candidateFacts: [],
        transcripts: [makeTranscript({ text: 'Weather was fine today, got here at eight.' })],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })
    const body = res.json<{ possibleMisses: unknown[] }>()
    expect(body.possibleMisses).toHaveLength(0)
  })

  it('generates fresh queue from candidate facts even when queueItem table is empty/stale', async () => {
    const { prisma } = await import('../src/db/client.js')
    // Unresolved fact exists, but no persisted queue items (simulates stale/never-refreshed state).
    // buildFreshQueueSections includes sourceNote + transcript on each fact (groupTimeLabel needs capturedAt).
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...makeFact({ status: 'DRAFT', id: FACT_ID }),
        sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-11T09:15:00.000Z') },
        transcript: { id: TRANSCRIPT_ID, text: 'Ordered plasterboard' },
      },
    ])
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    // Verify createMany was called — fresh items were generated, not just read from DB
    expect(vi.mocked(prisma.queueItem.createMany as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    const body = res.json<{ queue: { sections: Array<{ key: string; items: unknown[] }> } }>()
    const ordered = body.queue.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
  })

  it('links secondary facts in a duplicate group to the resulting memory item via review decision', async () => {
    const { prisma } = await import('../src/db/client.js')
    const decision = makeDecision({
      sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
      candidateFactId: null,
    })
    const memory = makeMemoryItem({
      sourceCandidateFactId: FACT_ID, // primary only; FACT_ID_2 is secondary
      reviewDecisionId: DECISION_ID,
    })
    const secondaryFact = makeFact({ id: FACT_ID_2, status: 'CONFIRMED' })
    const note = makeNote({ candidateFacts: [makeFact({ status: 'CONFIRMED' }), secondaryFact] })

    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([note])
    vi.mocked(prisma.reviewDecision.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([decision])
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([memory])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ notesByDay: Array<{ notes: Array<{ candidateFacts: Array<{ id: string; memoryItemIds: string[] }> }> }> }>()
    const facts = body.notesByDay[0].notes[0].candidateFacts
    const secondary = facts.find((f) => f.id === FACT_ID_2)
    expect(secondary?.memoryItemIds).toContain(MEMORY_ID)
  })

  it('groups notes under UK local date, not UTC date — note at 23:30 UTC lands on next BST day', async () => {
    const { prisma } = await import('../src/db/client.js')
    // 2026-06-10T23:30Z = 2026-06-11T00:30 BST (UTC+1 in summer)
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({ capturedAt: new Date('2026-06-10T23:30:00.000Z'), transcripts: [], candidateFacts: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ notesByDay: Array<{ localDate: string }> }>()
    expect(body.notesByDay[0].localDate).toBe('2026-06-11')
  })
})

// ── Cost fields ───────────────────────────────────────────────────────────────

describe('GET /api/internal/pilot/jobs/:jobId/inspection — cost fields', () => {
  const headers = { 'x-pilot-user-id': USER_ID, 'x-internal-inspection-key': INSPECTION_KEY }

  it('includes cost fields in candidateFacts', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNote({
        candidateFacts: [
          makeFact({ costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40' }),
        ],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ notesByDay: Array<{ notes: Array<{ candidateFacts: Array<Record<string, unknown>> }> }> }>()
    const fact = body.notesByDay[0].notes[0].candidateFacts[0]
    expect(fact.costAmount).toBe('5')
    expect(fact.costCurrency).toBe('GBP')
    expect(fact.costQualifier).toBe('each')
    expect(fact.totalCostAmount).toBe('40')
  })

  it('includes cost fields in memoryItems', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40' }),
    ])

    const res = await app.inject({ method: 'GET', url: INSPECTION_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ memoryItems: Array<Record<string, unknown>> }>()
    expect(body.memoryItems[0].costAmount).toBe('5')
    expect(body.memoryItems[0].costCurrency).toBe('GBP')
    expect(body.memoryItems[0].costQualifier).toBe('each')
    expect(body.memoryItems[0].totalCostAmount).toBe('40')
  })
})
