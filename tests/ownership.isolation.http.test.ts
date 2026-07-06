// Real-DB cross-user isolation audit: user B must not be able to list, fetch,
// or mutate user A's jobs or any child data, even knowing the IDs. Also proves
// every job-data route rejects unauthenticated requests, and that internal
// inspection requires BOTH an INTERNAL user and the inspection key.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { DevEmailProvider } from '../src/email/index.js'

const EMAIL_PREFIX = 'isolation-'
const TEST_SECRET = 'test-session-secret-long-enough!!'
const INSPECTION_KEY = 'test-inspection-key-long-enough!'

let app: FastifyInstance
let savedEnv: Record<string, string | undefined>

// User A's data graph (created directly via prisma)
let userAId: string
let jobId: string
let noteId: string
let factId: string
let queueItemId: string
let memoryItemId: string
let categoryId: string

// Session cookies
let cookieB: string // normal user B
let cookieInternal: string // INTERNAL-role user

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: ids } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.audioObject.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } })
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

beforeAll(async () => {
  savedEnv = {
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    PILOT_USER_ID: process.env.PILOT_USER_ID,
    INTERNAL_INSPECTION_KEY: process.env.INTERNAL_INSPECTION_KEY,
  }
  process.env.SESSION_COOKIE_SECRET = TEST_SECRET
  process.env.INTERNAL_INSPECTION_KEY = INSPECTION_KEY
  delete process.env.PILOT_USER_ID

  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
    email: new DevEmailProvider(),
  })
  await app.ready()
  await cleanup()

  // User A + full data graph, created directly
  const userA = await signupCookie('user-a')
  userAId = userA.id

  const job = await prisma.job.create({
    data: { ownerUserId: userAId, title: 'A garden room', jobType: 'garden_room' },
  })
  jobId = job.id

  const note = await prisma.rawNote.create({
    data: {
      jobId,
      clientNoteId: randomUUID(),
      capturedAt: new Date(),
      mimeType: 'audio/webm',
      sizeBytes: 100,
      serverStatus: 'TRANSCRIBED',
    },
  })
  noteId = note.id

  const transcript = await prisma.transcript.create({
    data: { noteId, status: 'COMPLETED', text: 'Ordered 12 sheets of plasterboard' },
  })

  const fact = await prisma.candidateFact.create({
    data: {
      jobId,
      sourceNoteId: noteId,
      sourceTranscriptId: transcript.id,
      factType: 'ORDERED_MATERIAL',
      summary: 'Ordered 12 sheets of plasterboard',
      confidenceLabel: 'HIGH',
      confidenceReason: 'clear statement',
      uncertaintyFlags: [],
    },
  })
  factId = fact.id

  const queueItem = await prisma.queueItem.create({
    data: {
      jobId,
      sectionKey: 'ordered',
      kind: 'single',
      reviewLabel: 'Ordered',
      summary: 'Ordered 12 sheets of plasterboard',
      proposedMemory: {},
      uncertaintyFlags: [],
      sourceCandidateFactIds: [factId],
    },
  })
  queueItemId = queueItem.id

  const decision = await prisma.reviewDecision.create({
    data: { jobId, decidedBy: userAId, action: 'CONFIRM', candidateFactId: factId },
  })

  const memoryItem = await prisma.memoryItem.create({
    data: {
      jobId,
      reviewDecisionId: decision.id,
      sourceCandidateFactId: factId,
      memoryType: 'ORDERED_MATERIAL',
      summary: 'Ordered 12 sheets of plasterboard',
    },
  })
  memoryItemId = memoryItem.id

  const category = await prisma.jobBudgetCategory.create({
    data: { jobId, name: 'Materials' },
  })
  categoryId = category.id

  // User B (normal) and an INTERNAL user
  const userB = await signupCookie('user-b')
  cookieB = userB.cookie

  const internal = await signupCookie('internal')
  await prisma.user.update({ where: { id: internal.id }, data: { role: 'INTERNAL' } })
  cookieInternal = internal.cookie
})

afterAll(async () => {
  await cleanup()
  await app.close()
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

const WEBM = Buffer.from('fake-webm-bytes')
function multipartNote() {
  const boundary = 'IsolationBoundary1a2b3c'
  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientNoteId"\r\n\r\n${randomUUID()}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="capturedAt"\r\n\r\n${new Date().toISOString()}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    WEBM,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

interface Attempt {
  name: string
  method: 'GET' | 'POST' | 'PATCH'
  url: () => string
  payload?: () => Record<string, unknown>
  multipart?: boolean
}

const ATTEMPTS: Attempt[] = [
  { name: 'get job', method: 'GET', url: () => `/api/jobs/${jobId}` },
  { name: 'list notes', method: 'GET', url: () => `/api/jobs/${jobId}/notes` },
  { name: 'get note', method: 'GET', url: () => `/api/jobs/${jobId}/notes/${noteId}` },
  { name: 'get transcript', method: 'GET', url: () => `/api/jobs/${jobId}/notes/${noteId}/transcript` },
  { name: 'get note facts', method: 'GET', url: () => `/api/jobs/${jobId}/notes/${noteId}/facts` },
  { name: 'upload note', method: 'POST', url: () => `/api/jobs/${jobId}/notes`, multipart: true },
  { name: 'list job facts', method: 'GET', url: () => `/api/jobs/${jobId}/facts` },
  { name: 'review draft', method: 'GET', url: () => `/api/jobs/${jobId}/review-draft` },
  {
    name: 'submit review decision',
    method: 'POST',
    url: () => `/api/jobs/${jobId}/review-decisions`,
    payload: () => ({ action: 'confirm', candidateFactId: factId }),
  },
  { name: 'list memory', method: 'GET', url: () => `/api/jobs/${jobId}/memory` },
  { name: 'review queue', method: 'GET', url: () => `/api/jobs/${jobId}/review-queue` },
  {
    name: 'queue decision',
    method: 'POST',
    url: () => `/api/jobs/${jobId}/review-queue-decisions`,
    payload: () => ({ queueItemId, action: 'confirm' }),
  },
  { name: 'memory view', method: 'GET', url: () => `/api/jobs/${jobId}/memory-view` },
  {
    name: 'direct-add memory item',
    method: 'POST',
    url: () => `/api/jobs/${jobId}/memory-items`,
    payload: () => ({ memoryType: 'ordered_material', summary: 'Injected by B' }),
  },
  {
    name: 'patch memory item',
    method: 'PATCH',
    url: () => `/api/jobs/${jobId}/memory-items/${memoryItemId}`,
    payload: () => ({ memoryType: 'ordered_material', summary: 'Tampered by B' }),
  },
  {
    name: 'verify memory item',
    method: 'POST',
    url: () => `/api/jobs/${jobId}/memory-items/${memoryItemId}/verify`,
  },
  { name: 'list budget categories', method: 'GET', url: () => `/api/jobs/${jobId}/budget-categories` },
  {
    name: 'create budget category',
    method: 'POST',
    url: () => `/api/jobs/${jobId}/budget-categories`,
    payload: () => ({ name: 'Injected by B' }),
  },
  {
    name: 'patch budget category',
    method: 'PATCH',
    url: () => `/api/jobs/${jobId}/budget-categories/${categoryId}`,
    payload: () => ({ name: 'Tampered by B' }),
  },
  { name: 'budget summary', method: 'GET', url: () => `/api/jobs/${jobId}/budget-summary` },
]

async function attempt(a: Attempt, headers: Record<string, string>) {
  if (a.multipart) {
    const { body, contentType } = multipartNote()
    return app.inject({ method: a.method, url: a.url(), headers: { ...headers, 'content-type': contentType }, payload: body })
  }
  return app.inject({
    method: a.method,
    url: a.url(),
    headers: { ...headers, ...(a.payload ? { 'content-type': 'application/json' } : {}) },
    ...(a.payload ? { payload: a.payload() } : {}),
  })
}

describe('cross-user isolation: user B against user A data', () => {
  it('B does not see A jobs in list/current', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: cookieB } })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([])

    const current = await app.inject({ method: 'GET', url: '/api/jobs/current', headers: { cookie: cookieB } })
    expect(current.statusCode).toBe(404)
  })

  it.each(ATTEMPTS.map((a) => [a.name, a] as const))('B cannot %s on A job', async (_name, a) => {
    const res = await attempt(a, { cookie: cookieB })
    expect([403, 404]).toContain(res.statusCode)
    expect(JSON.stringify(res.json())).not.toContain('plasterboard')
  })

  it('nothing of A was mutated by the attempts', async () => {
    const memory = await prisma.memoryItem.findMany({ where: { jobId } })
    expect(memory).toHaveLength(1)
    expect(memory[0].summary).toBe('Ordered 12 sheets of plasterboard')
    const cat = await prisma.jobBudgetCategory.findMany({ where: { jobId } })
    expect(cat).toHaveLength(1)
    expect(cat[0].name).toBe('Materials')
    expect(await prisma.rawNote.count({ where: { jobId } })).toBe(1)
  })

  it.each(ATTEMPTS.map((a) => [a.name, a] as const))('unauthenticated %s is rejected with 401', async (_name, a) => {
    const res = await attempt(a, {})
    expect(res.statusCode).toBe(401)
  })
})

describe('internal inspection support path', () => {
  const inspectionUrl = () => `/api/internal/pilot/jobs/${jobId}/inspection`

  it('INTERNAL user with inspection key can inspect another user job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: inspectionUrl(),
      headers: { cookie: cookieInternal, 'x-internal-inspection-key': INSPECTION_KEY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().job.id).toBe(jobId)
  })

  it('normal user with the correct key still cannot inspect another user job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: inspectionUrl(),
      headers: { cookie: cookieB, 'x-internal-inspection-key': INSPECTION_KEY },
    })
    expect(res.statusCode).toBe(403)
  })

  it('INTERNAL user without the key cannot inspect another user job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: inspectionUrl(),
      headers: { cookie: cookieInternal },
    })
    expect(res.statusCode).toBe(401)
  })

  it('INTERNAL user with a wrong key is rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: inspectionUrl(),
      headers: { cookie: cookieInternal, 'x-internal-inspection-key': 'wrong-key-wrong-key-wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('job owner can inspect their own job with the key', async () => {
    // Owner A has no live cookie in this suite; internal path already proves
    // key handling — owner path is proven via ownership check with a fresh login.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: `${EMAIL_PREFIX}user-a@test.local`, password: 'correct-horse-battery' },
    })
    expect(login.statusCode).toBe(200)
    const cookieA = cookieOf(login)
    const res = await app.inject({
      method: 'GET',
      url: inspectionUrl(),
      headers: { cookie: cookieA, 'x-internal-inspection-key': INSPECTION_KEY },
    })
    expect(res.statusCode).toBe(200)
  })
})
