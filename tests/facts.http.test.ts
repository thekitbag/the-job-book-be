import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'facts-user-1'
const JOB_ID = 'facts-job-1'
const NOTE_ID = 'facts-note-1'
const TRANSCRIPT_ID = 'facts-tx-1'

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
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  },
}))

function makeFact(overrides?: object) {
  return {
    id: 'fact-1',
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
    createdAt: new Date('2026-06-07T12:00:00Z'),
    updatedAt: new Date('2026-06-07T12:00:00Z'),
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
    id: USER_ID, email: 'test@test.local', name: 'Test', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue({
    id: JOB_ID, ownerUserId: USER_ID, title: 'Test Job', jobType: 'test',
    status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValue(null)
  vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValue({
    id: NOTE_ID, jobId: JOB_ID, clientNoteId: 'c1', serverStatus: 'EXTRACTED',
  })
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
})

describe('GET /api/jobs/:jobId/facts', () => {
  it('returns empty array when no facts exist', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/facts`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })

  it('returns facts with correct API shape', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([makeFact()])

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/facts`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({
      id: 'fact-1',
      jobId: JOB_ID,
      sourceNoteIds: [NOTE_ID],
      sourceTranscriptIds: [TRANSCRIPT_ID],
      factType: 'ordered_material',
      status: 'draft',
      summary: 'Ordered 12 sheets of plasterboard from Jewson',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
      supplierName: 'Jewson',
      confidenceLabel: 'high',
      confidenceReason: 'Stated explicitly',
      uncertaintyFlags: [],
      extractionSchemaVersion: 'v1',
    })
  })

  it('returns multiple facts in order', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([
      makeFact({ id: 'fact-1', factType: 'ORDERED_MATERIAL' }),
      makeFact({ id: 'fact-2', factType: 'LEFTOVER_MATERIAL', confidenceLabel: 'LOW', uncertaintyFlags: ['approximate_quantity'] }),
    ])

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/facts`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveLength(2)
    expect(json[0].factType).toBe('ordered_material')
    expect(json[1].factType).toBe('leftover_material')
    expect(json[1].confidenceLabel).toBe('low')
    expect(json[1].uncertaintyFlags).toEqual(['approximate_quantity'])
  })

  it('returns 404 for unknown job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce(null)

    const response = await app.inject({
      method: 'GET', url: '/api/jobs/no-such-job/facts', headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 403 when job belongs to another user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValueOnce({
      id: JOB_ID, ownerUserId: 'other-user', title: 'T', jobType: 't',
      status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(),
    })

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/facts`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('GET /api/jobs/:jobId/notes/:noteId/facts', () => {
  it('returns facts scoped to the note', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([makeFact()])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/notes/${NOTE_ID}/facts`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toHaveLength(1)
    expect(json[0].sourceNoteIds).toEqual([NOTE_ID])
  })

  it('returns 404 when note does not belong to job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValueOnce(null)

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/notes/no-such-note/facts`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'NOTE_NOT_FOUND' })
  })

  it('returns unclear fact with status "unclear"', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValueOnce([
      makeFact({ factType: 'UNCLEAR', status: 'UNCLEAR', confidenceLabel: 'LOW' }),
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/notes/${NOTE_ID}/facts`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json[0].factType).toBe('unclear')
    expect(json[0].status).toBe('unclear')
  })
})
