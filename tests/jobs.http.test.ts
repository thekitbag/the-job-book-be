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
      update: vi.fn(),
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
    status: 'STARTED',
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
  it('returns the authenticated users non-archived jobs', async () => {
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
      expect.objectContaining({
        where: { ownerUserId: USER_ID, status: { in: ['PLANNING', 'STARTED', 'FINISHED'] } },
      })
    )
  })

  it('excludes archived jobs from the list at the query level', async () => {
    const { prisma } = await import('../src/db/client.js')
    // Prisma applies the filter — mock returns only what would pass it
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeJob({ status: 'STARTED' }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Array<{ status: string }>>()
    // The visible-status filter never includes ARCHIVED
    const where = vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where
    expect(where.status.in).toEqual(['PLANNING', 'STARTED', 'FINISHED'])
    expect(body).toHaveLength(1)
    expect(body[0].status).toBe('started')
  })

  it('returns empty list when user has no active jobs', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('returns normalized lowercase status in list response', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeJob({ status: 'STARTED' }),
    ])

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Array<{ status: string }>>()
    expect(body[0].status).toBe('started')
  })
})

describe('GET /api/jobs/current', () => {
  it('returns normalized most recent active job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeJob()])

    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/current',
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string; status: string; jobType: string }>()
    expect(body.id).toBe(JOB_ID)
    expect(body.status).toBe('started')
    expect(body.jobType).toBe('garden_room')
    expect(vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerUserId: USER_ID, status: { in: ['PLANNING', 'STARTED', 'FINISHED'] } },
      })
    )
  })

  it('returns 404 when no non-archived job exists', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

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
    expect(body.status).toBe('started')
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
    expect(body.status).toBe('started')
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

describe('PATCH /api/jobs/:jobId — title edit', () => {
  const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }

  beforeEach(async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
    vi.mocked((prisma.job as any).update).mockImplementation(async ({ data }: any) => ({
      ...makeJob(), ...data, updatedAt: new Date(),
    }))
  })

  it('updates the title and returns the normalized job shape', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: 'Sandbanks garden room' } })
    expect(res.statusCode).toBe(200)
    const body = res.json<any>()
    expect(body).toMatchObject({ id: JOB_ID, title: 'Sandbanks garden room', jobType: 'garden_room', status: 'started' })
    expect(body).not.toHaveProperty('ownerUserId')
  })

  it('trims whitespace from the title', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: '  Sandbanks job  ' } })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked((prisma.job as any).update).mock.calls[0][0].data.title).toBe('Sandbanks job')
  })

  it('rejects a blank title with 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('INVALID_FIELD')
  })

  it('rejects a title over 80 characters with 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: 'x'.repeat(81) } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('INVALID_FIELD')
  })

  it('rejects a body with no editable field with 400', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('MISSING_FIELD')
  })

  it('does not allow jobType changes and ignores unknown fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: 'New title', jobType: 'extension', nonsense: true } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma.job as any).update).mock.calls[0][0].data
    expect(data).toEqual({ title: 'New title' })
  })

  it('rejects a non-owner with 403 and an unknown job with 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    const forbidden = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: 'Hijack' } })
    expect(forbidden.statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    const missing = await app.inject({ method: 'PATCH', url: '/api/jobs/nope', headers, payload: { title: 'Hijack' } })
    expect(missing.statusCode).toBe(404)
    expect(vi.mocked((prisma.job as any).update)).not.toHaveBeenCalled()
  })

  it('the updated title flows through GET /api/jobs/:jobId', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ title: 'Sandbanks garden room' }))
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}`, headers: { 'x-pilot-user-id': USER_ID } })
    expect(res.json<any>().title).toBe('Sandbanks garden room')
  })
})

describe('PATCH /api/jobs/:jobId — status edit', () => {
  const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }

  beforeEach(async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
    vi.mocked((prisma.job as any).update).mockImplementation(async ({ data }: any) => ({
      ...makeJob(), ...data, updatedAt: new Date(),
    }))
  })

  it.each(['planning', 'started', 'finished', 'archived'])('updates status to %s and returns it lower-case', async (status) => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status } })
    expect(res.statusCode).toBe(200)
    expect(res.json<any>().status).toBe(status)
    const data = vi.mocked((prisma.job as any).update).mock.calls.at(-1)[0].data
    expect(data).toEqual({ status: status.toUpperCase() })
  })

  it('updates title and status together', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { title: '  Winter job  ', status: 'planning' } })
    expect(res.statusCode).toBe(200)
    const body = res.json<any>()
    expect(body.title).toBe('Winter job')
    expect(body.status).toBe('planning')
    expect(vi.mocked((prisma.job as any).update).mock.calls[0][0].data).toEqual({ title: 'Winter job', status: 'PLANNING' })
  })

  it('rejects an invalid status with 400 INVALID_FIELD', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status: 'someday' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('INVALID_FIELD')
  })

  it('accepts archived: it is a status change, not a delete', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status: 'archived' } })
    expect(res.statusCode).toBe(200)
    expect(res.json<any>().status).toBe('archived')
    // only a status update — no delete call exists on this route
    expect(vi.mocked((prisma.job as any).update).mock.calls[0][0].data).toEqual({ status: 'ARCHIVED' })
  })

  it('rejects legacy/unknown statuses (active, paused, completed, on_hold)', async () => {
    for (const status of ['active', 'paused', 'completed', 'on_hold']) {
      const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status } })
      expect(res.statusCode, status).toBe(400)
      expect(res.json<any>().code).toBe('INVALID_FIELD')
    }
  })

  it('still rejects a body with no editable field', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('MISSING_FIELD')
  })

  it('status-only patch leaves the title untouched', async () => {
    const { prisma } = await import('../src/db/client.js')
    await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status: 'planning' } })
    const data = vi.mocked((prisma.job as any).update).mock.calls[0][0].data
    expect('title' in data).toBe(false)
  })

  it('non-owner cannot update status; unknown job is 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}`, headers, payload: { status: 'planning' } })).statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'PATCH', url: '/api/jobs/nope', headers, payload: { status: 'planning' } })).statusCode).toBe(404)
  })
})

describe('job visibility after status changes', () => {
  const headers = { 'x-pilot-user-id': USER_ID }

  it('GET /api/jobs includes planning, started, and finished jobs but not archived', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as any).mockResolvedValue([
      makeJob({ id: 'j-planning', status: 'PLANNING' }),
      makeJob({ id: 'j-started', status: 'STARTED' }),
      makeJob({ id: 'j-done', status: 'FINISHED' }),
    ])
    const res = await app.inject({ method: 'GET', url: '/api/jobs', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json<any>().map((j: any) => j.status)).toEqual(['planning', 'started', 'finished'])
    // the query itself must include the three visible statuses and exclude ARCHIVED
    const where = vi.mocked(prisma.job.findMany as any).mock.calls[0][0].where
    expect(where.status).toEqual({ in: ['PLANNING', 'STARTED', 'FINISHED'] })
  })

  it('GET /api/jobs/current prefers the most recent STARTED job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as any).mockResolvedValue([
      makeJob({ id: 'j-planning', status: 'PLANNING', updatedAt: new Date('2026-07-11T10:00:00.000Z') }),
      makeJob({ id: 'j-started', status: 'STARTED', updatedAt: new Date('2026-07-01T10:00:00.000Z') }),
    ])
    const res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers })
    expect(res.statusCode).toBe(200)
    expect(res.json<any>().id).toBe('j-started')
  })

  it('GET /api/jobs/current falls back to planning, then finished', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as any).mockResolvedValue([
      makeJob({ id: 'j-done', status: 'FINISHED', updatedAt: new Date('2026-07-11T10:00:00.000Z') }),
      makeJob({ id: 'j-planning', status: 'PLANNING', updatedAt: new Date('2026-07-01T10:00:00.000Z') }),
    ])
    let res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers })
    expect(res.json<any>().id).toBe('j-planning')

    vi.mocked(prisma.job.findMany as any).mockResolvedValue([
      makeJob({ id: 'j-done', status: 'FINISHED' }),
    ])
    res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers })
    expect(res.json<any>().id).toBe('j-done')
  })

  it('GET /api/jobs/current returns 404 only when no non-archived jobs exist', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as any).mockResolvedValue([])
    const res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers })
    expect(res.statusCode).toBe(404)
  })
})
