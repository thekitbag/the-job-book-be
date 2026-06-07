import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'

// Tiny limit so oversized tests only need a small buffer
const TEST_MAX_BYTES = 100

const USER_ID = 'http-user-1'
const JOB_ID = 'http-job-1'

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
    $transaction: vi.fn(),
  },
}))

function buildMultipart(
  fields: Record<string, string>,
  file?: { fieldname: string; data: Buffer; mimeType: string },
): { body: Buffer; contentType: string } {
  const boundary = 'TestBoundary7a8b9c'
  const parts: Buffer[] = []

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }

  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="audio.webm"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ),
    )
    parts.push(file.data)
    parts.push(Buffer.from('\r\n'))
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

let app: FastifyInstance
let storage: FakeAudioStorage

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPrisma(): any {
  // Dynamic import returns the mocked module
  return (vi as any)._mockedModules?.get('../src/db/client.js')?.exports?.prisma
}

beforeAll(async () => {
  storage = new FakeAudioStorage()
  app = buildApp({ storage, transcription: new FakeTranscriptionProvider(), maxAudioBytes: TEST_MAX_BYTES })
  await app.ready()
})

afterAll(() => app.close())

beforeEach(async () => {
  storage.clear()
  vi.clearAllMocks()

  const { prisma } = await import('../src/db/client.js')

  // Auth: always resolve the test user
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue({
    id: USER_ID,
    email: 'test@test.local',
    name: 'Test User',
    role: 'PILOT',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // Default: job exists and belongs to user
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue({
    id: JOB_ID,
    ownerUserId: USER_ID,
    title: 'Test Job',
    jobType: 'test',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // Default: no duplicate
  vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValue(null)

  // Default: transaction creates successfully
  vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
    await fn({
      rawNote: { create: vi.fn().mockResolvedValue({}) },
      audioObject: { create: vi.fn().mockResolvedValue({}) },
    })
  })
})

describe('POST /api/jobs/:jobId/notes — response shape', () => {
  it('returns noteId, clientNoteId, status, isDuplicate on success', async () => {
    const { body, contentType } = buildMultipart(
      {
        clientNoteId: 'shape-test-1',
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/webm',
      },
      { fieldname: 'audio', data: Buffer.from('x'.repeat(50)), mimeType: 'audio/webm' },
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/notes`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': contentType },
      payload: body,
    })

    expect(response.statusCode).toBe(201)
    const json = response.json()
    expect(json).toMatchObject({
      noteId: expect.any(String),
      clientNoteId: 'shape-test-1',
      status: 'UPLOADED',
      isDuplicate: false,
    })
  })
})

describe('POST /api/jobs/:jobId/notes — idempotency', () => {
  it('returns existing note with isDuplicate:true and status 200 on duplicate clientNoteId', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValue({
      id: 'existing-note-99',
      clientNoteId: 'dup-client-id',
      jobId: JOB_ID,
      serverStatus: 'UPLOADED',
      capturedAt: new Date(),
      uploadedAt: new Date(),
      mimeType: 'audio/webm',
      durationMs: null,
      sizeBytes: 50,
      createdAt: new Date(),
      updatedAt: new Date(),
      audioObject: null,
    })

    const { body, contentType } = buildMultipart(
      {
        clientNoteId: 'dup-client-id',
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/webm',
      },
      { fieldname: 'audio', data: Buffer.from('x'.repeat(50)), mimeType: 'audio/webm' },
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/notes`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': contentType },
      payload: body,
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toMatchObject({
      noteId: 'existing-note-99',
      clientNoteId: 'dup-client-id',
      isDuplicate: true,
    })
    // No audio should have been stored for a duplicate
    expect(storage.stored.size).toBe(0)
  })
})

describe('POST /api/jobs/:jobId/notes — validation', () => {
  it('returns 415 AUDIO_UNSUPPORTED_TYPE for audio/mp4', async () => {
    const { body, contentType } = buildMultipart(
      {
        clientNoteId: 'mime-test-1',
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/mp4',
      },
      { fieldname: 'audio', data: Buffer.from('x'.repeat(50)), mimeType: 'audio/mp4' },
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/notes`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': contentType },
      payload: body,
    })

    expect(response.statusCode).toBe(415)
    expect(response.json()).toMatchObject({ code: 'AUDIO_UNSUPPORTED_TYPE' })
  })

  it('returns 413 AUDIO_TOO_LARGE when file exceeds the limit', async () => {
    // TEST_MAX_BYTES is 100; send 150 bytes
    const { body, contentType } = buildMultipart(
      {
        clientNoteId: 'size-test-1',
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/webm',
      },
      { fieldname: 'audio', data: Buffer.from('x'.repeat(150)), mimeType: 'audio/webm' },
    )

    const response = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/notes`,
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': contentType },
      payload: body,
    })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ code: 'AUDIO_TOO_LARGE' })
  })
})

describe('CORS', () => {
  it('allows configured HTTPS origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        Origin: 'https://localhost:5173',
      },
    })

    expect(response.headers['access-control-allow-origin']).toBe('https://localhost:5173')
  })

  it('allows a second origin from a comma-separated CORS_ORIGIN list', async () => {
    // Temporarily set env to include a second origin
    const original = process.env.CORS_ORIGIN
    process.env.CORS_ORIGIN = 'https://localhost:5173,https://192.168.1.10:5173'
    // Build a fresh app so it picks up the new env value
    const app2 = buildApp({ storage, transcription: new FakeTranscriptionProvider(), maxAudioBytes: TEST_MAX_BYTES })
    await app2.ready()

    const response = await app2.inject({
      method: 'GET',
      url: '/health',
      headers: {
        Origin: 'https://192.168.1.10:5173',
      },
    })

    await app2.close()
    process.env.CORS_ORIGIN = original

    expect(response.headers['access-control-allow-origin']).toBe('https://192.168.1.10:5173')
  })

  it('does not set ACAO header for a disallowed origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        Origin: 'http://evil.example.com',
      },
    })

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('GET /api/jobs/:jobId/notes — transcript status in list', () => {
  it('returns transcript status "waiting" when no transcript exists', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findMany as any).mockResolvedValueOnce([
      {
        id: 'note-1', clientNoteId: 'c1', capturedAt: new Date(), uploadedAt: new Date(),
        mimeType: 'audio/webm', durationMs: null, sizeBytes: 100, serverStatus: 'UPLOADED',
        transcripts: [],
      },
    ])

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0].transcript).toEqual({ status: 'waiting' })
  })

  it('returns transcript status "ready" when transcript is COMPLETED', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findMany as any).mockResolvedValueOnce([
      {
        id: 'note-2', clientNoteId: 'c2', capturedAt: new Date(), uploadedAt: new Date(),
        mimeType: 'audio/webm', durationMs: 4000, sizeBytes: 200, serverStatus: 'TRANSCRIBED',
        transcripts: [{ status: 'COMPLETED', text: 'Ordered 12 sheets.', createdAt: new Date() }],
      },
    ])

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    // List response contains status only — no text
    expect(response.json()[0].transcript).toEqual({ status: 'ready' })
  })

  it('returns transcript status "failed" when transcript has FAILED', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findMany as any).mockResolvedValueOnce([
      {
        id: 'note-3', clientNoteId: 'c3', capturedAt: new Date(), uploadedAt: new Date(),
        mimeType: 'audio/webm', durationMs: null, sizeBytes: 150, serverStatus: 'FAILED',
        transcripts: [{ status: 'FAILED', text: null, createdAt: new Date() }],
      },
    ])

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0].transcript).toEqual({ status: 'failed' })
  })
})

describe('GET /api/jobs/:jobId/notes/:noteId — transcript status in detail', () => {
  it('returns transcript status (no text) for a ready note', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValueOnce({
      id: 'note-detail-1', clientNoteId: 'cd1', capturedAt: new Date(), uploadedAt: new Date(),
      mimeType: 'audio/webm', durationMs: 5000, sizeBytes: 300, serverStatus: 'TRANSCRIBED',
      transcripts: [{ status: 'COMPLETED', text: 'Used six OSB boards on the back wall.', createdAt: new Date() }],
    })

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes/note-detail-1`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    // Detail response also contains status only — text is fetched via /transcript endpoint
    expect(response.json().transcript).toEqual({ status: 'ready' })
  })
})

describe('GET /api/jobs/:jobId/notes/:noteId/transcript', () => {
  it('returns waiting when no transcript exists', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValueOnce({
      id: 'note-tx-1', clientNoteId: 'ctx1', capturedAt: new Date(), uploadedAt: new Date(),
      mimeType: 'audio/webm', durationMs: null, sizeBytes: 100, serverStatus: 'UPLOADED',
      transcripts: [],
    })

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes/note-tx-1/transcript`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ noteId: 'note-tx-1', status: 'waiting' })
  })

  it('returns ready with full transcript text', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValueOnce({
      id: 'note-tx-2', clientNoteId: 'ctx2', capturedAt: new Date(), uploadedAt: new Date(),
      mimeType: 'audio/webm', durationMs: 4000, sizeBytes: 200, serverStatus: 'TRANSCRIBED',
      transcripts: [{
        status: 'COMPLETED', text: 'Ordered 12 sheets of plasterboard from Jewson.',
        language: 'en', provider: 'openai', model: 'whisper-1',
        errorCode: null, completedAt: new Date(), createdAt: new Date(),
      }],
    })

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes/note-tx-2/transcript`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    const json = response.json()
    expect(json).toMatchObject({
      noteId: 'note-tx-2',
      status: 'ready',
      text: 'Ordered 12 sheets of plasterboard from Jewson.',
      language: 'en',
      provider: 'openai',
      model: 'whisper-1',
    })
  })

  it('returns failed status with errorCode', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValueOnce({
      id: 'note-tx-3', clientNoteId: 'ctx3', capturedAt: new Date(), uploadedAt: new Date(),
      mimeType: 'audio/webm', durationMs: null, sizeBytes: 150, serverStatus: 'FAILED',
      transcripts: [{
        status: 'FAILED', text: null, language: null, provider: 'openai', model: 'whisper-1',
        errorCode: 'PROVIDER_ERROR', completedAt: new Date(), createdAt: new Date(),
      }],
    })

    const response = await app.inject({
      method: 'GET', url: `/api/jobs/${JOB_ID}/notes/note-tx-3/transcript`, headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ noteId: 'note-tx-3', status: 'failed', errorCode: 'PROVIDER_ERROR' })
  })
})
