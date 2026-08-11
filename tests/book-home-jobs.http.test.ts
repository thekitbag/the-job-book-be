// Book Home / All Jobs / New Job navigation contracts. Book Home is a
// cross-job index, not a dashboard: the backend slice is only the jobs list
// (grouping inputs) and lightweight job creation. Real DB, no mocks.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { DevEmailProvider } from '../src/email/index.js'

const EMAIL_PREFIX = 'book-home-test-'
const TEST_SECRET = 'test-session-secret-long-enough!!'

let app: FastifyInstance
let savedEnv: Record<string, string | undefined>

let userAId: string
let cookieA: string
let cookieB: string

type Job = {
  id: string
  title: string
  jobType: string | null
  status: string
  roughLocationOrLabel: string | null
  siteAddress: string | null
  createdAt: string
  updatedAt: string
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.job.deleteMany({ where: { ownerUserId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string]
  return cookies.find((c) => c?.startsWith('jobbook_session='))!.split(';')[0]
}

async function signupCookie(local: string): Promise<{ id: string; cookie: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'content-type': 'application/json' },
    payload: { email: `${EMAIL_PREFIX}${local}@test.local`, password: 'correct-horse-battery' },
  })
  expect(res.statusCode).toBe(201)
  return { id: res.json().user.id, cookie: cookieOf(res) }
}

const json = (cookie: string) => ({ cookie, 'content-type': 'application/json' })

function createJob(payload: object, cookie = cookieA) {
  return app.inject({ method: 'POST', url: '/api/jobs', headers: json(cookie), payload })
}

async function listJobs(cookie = cookieA): Promise<Job[]> {
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })
  expect(res.statusCode).toBe(200)
  return res.json<Job[]>()
}

beforeAll(async () => {
  savedEnv = {
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    PILOT_USER_ID: process.env.PILOT_USER_ID,
  }
  process.env.SESSION_COOKIE_SECRET = TEST_SECRET
  delete process.env.PILOT_USER_ID

  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
    email: new DevEmailProvider(),
  })
  await app.ready()
  await cleanup()

  const userA = await signupCookie('user-a')
  userAId = userA.id
  cookieA = userA.cookie

  const userB = await signupCookie('user-b')
  cookieB = userB.cookie
})

afterAll(async () => {
  await cleanup()
  await app.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(async () => {
  await prisma.job.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } })
})

describe('GET /api/jobs — Book Home and All Jobs grouping inputs', () => {
  beforeEach(async () => {
    await prisma.job.createMany({
      data: [
        { ownerUserId: userAId, title: 'Poole garden room', jobType: 'garden_room', status: 'STARTED' },
        { ownerUserId: userAId, title: 'Sandbanks loft', jobType: 'extension', status: 'PLANNING' },
        { ownerUserId: userAId, title: 'Old bathroom', jobType: 'other', status: 'FINISHED' },
        { ownerUserId: userAId, title: 'Shelved shed', jobType: 'other', status: 'ARCHIVED' },
      ],
    })
  })

  it('includes started, planning, and finished jobs and excludes archived', async () => {
    const jobs = await listJobs()
    expect(jobs.map((j) => j.title).sort()).toEqual(['Old bathroom', 'Poole garden room', 'Sandbanks loft'])
    expect(jobs.map((j) => j.status).sort()).toEqual(['finished', 'planning', 'started'])
    expect(jobs.some((j) => j.status === 'archived')).toBe(false)
  })

  it('returns the fields the index groups and labels on, and no cross-job money/workshop fields', async () => {
    const [job] = await listJobs()
    expect(Object.keys(job).sort()).toEqual(
      ['createdAt', 'id', 'jobType', 'roughLocationOrLabel', 'siteAddress', 'status', 'title', 'updatedAt'].sort()
    )
  })

  it('orders deterministically and repeats the same order across requests', async () => {
    const first = await listJobs()
    const second = await listJobs()
    expect(second.map((j) => j.id)).toEqual(first.map((j) => j.id))
    const updatedAt = first.map((j) => new Date(j.updatedAt).getTime())
    expect([...updatedAt].sort((a, b) => b - a)).toEqual(updatedAt)
  })

  it('is owner scoped: another user sees none of these jobs', async () => {
    expect(await listJobs(cookieB)).toEqual([])
  })
})

describe('POST /api/jobs — New Job', () => {
  it('creates one In progress job by default and it appears in the list', async () => {
    const res = await createJob({ title: 'New garden room' })
    expect(res.statusCode).toBe(201)
    const body = res.json<Job>()
    expect(body.status).toBe('started')
    expect(body.roughLocationOrLabel).toBeNull()

    const jobs = await listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(body.id)
    expect(jobs[0].status).toBe('started')
  })

  it('creates a Planning job with a Where value and preserves both', async () => {
    const res = await createJob({ title: 'Quoted loft', status: 'planning', roughLocationOrLabel: '  Sandbanks Road  ' })
    expect(res.statusCode).toBe(201)
    expect(res.json<Job>()).toMatchObject({
      title: 'Quoted loft',
      status: 'planning',
      roughLocationOrLabel: 'Sandbanks Road',
    })

    const [listed] = await listJobs()
    expect(listed).toMatchObject({ title: 'Quoted loft', status: 'planning', roughLocationOrLabel: 'Sandbanks Road' })
  })

  it('rejects finished and archived on create and stores nothing', async () => {
    for (const status of ['finished', 'archived']) {
      const res = await createJob({ title: 'Old job', status })
      expect(res.statusCode, status).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('INVALID_FIELD')
    }
    expect(await listJobs()).toEqual([])
  })

  it('keeps existing title validation', async () => {
    expect((await createJob({ title: '   ' })).statusCode).toBe(400)
    expect((await createJob({})).statusCode).toBe(400)
    expect((await createJob({ title: 'x'.repeat(81) })).statusCode).toBe(400)
    expect((await createJob({ title: '  Trimmed  ' })).json<Job>().title).toBe('Trimmed')
  })

  it('does not accept contact, budget, date, or customer fields', async () => {
    const res = await createJob({
      title: 'Padded job',
      customerName: 'Mrs Smith',
      budgetAmount: '1000',
      startDate: '2026-08-01',
      siteAddress: '12 Sandbanks Road',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<Job>()
    expect(body.siteAddress).toBeNull()
    expect(Object.keys(body)).not.toContain('customerName')
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: body.id } })
    expect(stored.siteAddress).toBeNull()
    expect(stored.customerTotalAmount).toBeNull()
  })

  it('is owner scoped: a job created by user B is invisible to user A', async () => {
    const res = await createJob({ title: 'User B loft' }, cookieB)
    expect(res.statusCode).toBe(201)
    expect(await listJobs(cookieA)).toEqual([])
    expect((await listJobs(cookieB)).map((j) => j.title)).toEqual(['User B loft'])
  })
})

describe('current/selected job compatibility', () => {
  it('status correction through PATCH stays reversible and never hides the job from the list', async () => {
    const created = (await createJob({ title: 'Poole garden room' })).json<Job>()

    for (const status of ['planning', 'finished', 'started']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${created.id}`,
        headers: json(cookieA),
        payload: { status },
      })
      expect(res.statusCode, status).toBe(200)
      expect(res.json<Job>().status).toBe(status)
      expect((await listJobs()).map((j) => j.id)).toEqual([created.id])
    }
  })

  it('GET /api/jobs/current still resolves a newly created job', async () => {
    const created = (await createJob({ title: 'Poole garden room' })).json<Job>()
    const res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers: { cookie: cookieA } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Job>().id).toBe(created.id)
  })

  it('GET /api/jobs/current still resolves a planning-only book', async () => {
    const created = (await createJob({ title: 'Quoted loft', status: 'planning' })).json<Job>()
    const res = await app.inject({ method: 'GET', url: '/api/jobs/current', headers: { cookie: cookieA } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Job>().id).toBe(created.id)
  })
})
