import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'jobs-user-1'
const OTHER_USER_ID = 'jobs-other-user'
const JOB_ID = 'jobs-job-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    audioObject: { create: vi.fn() },
    transcript: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    reviewDecision: { create: vi.fn() },
    memoryItem: { findMany: vi.fn() },
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
    createdAt: new Date('2026-06-10T10:00:00.000Z'),
    updatedAt: new Date('2026-06-10T10:00:00.000Z'),
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
  process.env.PILOT_USER_ID = USER_ID
  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER_ID,
    email: 'pilot@test.local',
    name: 'Pilot',
    role: 'PILOT',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
})

describe('GET /api/jobs', () => {
  it('returns only the authenticated users jobs', async () => {
    const { prisma } = await import('../src/db/client.js')
    const jobs = [makeJob(), makeJob({ id: 'jobs-job-2', title: 'Bournemouth extension' })]
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(jobs)

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<unknown[]>()
    expect(body).toHaveLength(2)
    expect(vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerUserId: USER_ID } })
    )
  })

  it('returns normalized lowercase status in list response', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeJob({ status: 'ACTIVE' }),
      makeJob({ id: 'jobs-job-2', status: 'COMPLETED' }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Array<{ status: string }>>()
    expect(body[0].status).toBe('active')
    expect(body[1].status).toBe('completed')
  })
})

describe('GET /api/jobs/current', () => {
  it('returns normalized most recent active job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/current',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string; status: string; jobType: string }>()
    expect(body.id).toBe(JOB_ID)
    expect(body.status).toBe('active')
    expect(body.jobType).toBe('garden_room')
    expect(vi.mocked(prisma.job.findFirst as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerUserId: USER_ID, status: 'ACTIVE' } })
    )
  })

  it('returns 404 when no active job exists', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/current',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('JOB_NOT_FOUND')
  })
})

describe('GET /api/jobs/:jobId', () => {
  it('returns normalized job for the authenticated owner', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; id: string }>()
    expect(body.id).toBe(JOB_ID)
    expect(body.status).toBe('active')
  })

  it('returns 403 for cross-user access', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ ownerUserId: OTHER_USER_ID })
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN')
  })
})

describe('POST /api/jobs', () => {
  it('creates a job with title and jobType', async () => {
    const { prisma } = await import('../src/db/client.js')
    const created = makeJob({ title: 'Poole garden room', jobType: 'garden_room' })
    vi.mocked(prisma.job.create as ReturnType<typeof vi.fn>).mockResolvedValue(created)

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: 'Poole garden room', jobType: 'garden_room' },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string; status: string; jobType: string }>()
    expect(body.id).toBe(JOB_ID)
    expect(body.status).toBe('active')
    expect(body.jobType).toBe('garden_room')
  })

  it('defaults missing jobType to other', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ jobType: 'other' })
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: 'Unnamed job' },
    })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(prisma.job.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobType: 'other' }) })
    )
  })

  it('trims whitespace from title', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ title: 'Trimmed title' })
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: '  Trimmed title  ' },
    })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(prisma.job.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Trimmed title' }) })
    )
  })

  it('rejects blank title with 400 MISSING_FIELD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: '   ' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('MISSING_FIELD')
  })

  it('rejects missing title with 400 MISSING_FIELD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('MISSING_FIELD')
  })

  it('rejects overlong title with 400 INVALID_FIELD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: 'A'.repeat(81) },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('INVALID_FIELD')
  })

  it('rejects unknown jobType with 400 INVALID_FIELD', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' },
      payload: { title: 'Valid title', jobType: 'mansion_block' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('INVALID_FIELD')
  })
})
