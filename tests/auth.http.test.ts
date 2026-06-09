import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { createSessionToken } from '../src/lib/session.js'

const USER_ID = 'auth-user-1'
const JOB_ID = 'auth-job-1'
const TEST_PASSCODE = 'test-passcode-123'
const TEST_SECRET = 'test-session-secret-long-enough'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    audioObject: { create: vi.fn() },
    transcript: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    reviewDecision: { create: vi.fn() },
    memoryItem: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))

function makeUser() {
  return { id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date() }
}

function makeJob() {
  return { id: JOB_ID, ownerUserId: USER_ID, title: 'Test Job', jobType: 'test', status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date() }
}

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
    PILOT_PASSCODE: process.env.PILOT_PASSCODE,
    PILOT_USER_ID: process.env.PILOT_USER_ID,
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    NODE_ENV: process.env.NODE_ENV,
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  }

  process.env.PILOT_PASSCODE = TEST_PASSCODE
  process.env.PILOT_USER_ID = USER_ID
  process.env.SESSION_COOKIE_SECRET = TEST_SECRET
  process.env.FRONTEND_ORIGIN = 'https://thejobbook.app'
  delete process.env.NODE_ENV

  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.rawNote.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
})

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

// ─── GET /health ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with no credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })
})

// ─── POST /api/auth/pilot-login ───────────────────────────────────────────────

describe('POST /api/auth/pilot-login', () => {
  it('returns ok and sets session cookie on correct passcode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      headers: { 'content-type': 'application/json' },
      payload: { passcode: TEST_PASSCODE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    expect(res.headers['set-cookie']).toBeDefined()
    expect(res.headers['set-cookie']).toMatch(/pilot_session=/)
    expect(res.headers['set-cookie']).toMatch(/HttpOnly/i)
  })

  it('returns 401 on wrong passcode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      headers: { 'content-type': 'application/json' },
      payload: { passcode: 'wrong-passcode' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('returns 400 when passcode is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      headers: { 'content-type': 'application/json' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('does not require session cookie or user header to call', async () => {
    // Login endpoint must be accessible without auth
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/pilot-login',
      headers: { 'content-type': 'application/json' },
      payload: { passcode: TEST_PASSCODE },
    })

    expect(res.statusCode).not.toBe(401)
  })
})

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    const setCookie = res.headers['set-cookie'] as string | undefined
    expect(setCookie).toMatch(/pilot_session=/)
    // Clearing is done by setting MaxAge=0 or Expires in the past
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })

  it('production: clearing cookie carries matching Domain/Secure/SameSite so browser deletes it', async () => {
    process.env.NODE_ENV = 'production'
    process.env.COOKIE_DOMAIN = '.thejobbook.app'

    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })

    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie'] as string
    expect(setCookie).toMatch(/pilot_session=/)
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=None/i)
    expect(setCookie).toMatch(/Domain=\.thejobbook\.app/i)
    expect(setCookie).toMatch(/Path=\//i)
  })
})

// ─── Cookie-based auth on protected routes ────────────────────────────────────

describe('Cookie-based auth', () => {
  it('grants access to protected route with valid session cookie', async () => {
    const token = createSessionToken(USER_ID, TEST_SECRET)

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { Cookie: `pilot_session=${token}` },
    })

    expect(res.statusCode).toBe(200)
  })

  it('returns 401 with no cookie and no header', async () => {
    // In production mode there is no dev fallback — missing session is always rejected
    process.env.NODE_ENV = 'production'

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('returns 401 with tampered session cookie', async () => {
    // In production mode an invalid cookie is rejected immediately (no dev fallback)
    process.env.NODE_ENV = 'production'

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { Cookie: 'pilot_session=tampered.badsignature' },
    })

    expect(res.statusCode).toBe(401)
  })

  it('returns 401 with an expired session cookie', async () => {
    // In production mode an expired cookie is rejected immediately (no dev fallback)
    process.env.NODE_ENV = 'production'

    // Manually craft an expired token
    const { createHmac } = await import('node:crypto')
    const payload = { userId: USER_ID, iat: 1000, exp: 1001 } // exp in the past
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', TEST_SECRET).update(encodedPayload).digest('base64url')
    const expiredToken = `${encodedPayload}.${sig}`

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { Cookie: `pilot_session=${expiredToken}` },
    })

    expect(res.statusCode).toBe(401)
  })

  it('dev: X-Pilot-User-Id header still works when NODE_ENV is not production', async () => {
    // Ensure NODE_ENV is not 'production'
    delete process.env.NODE_ENV

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}`,
      headers: { 'x-pilot-user-id': USER_ID },
    })

    expect(res.statusCode).toBe(200)
  })
})

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('allows the production frontend origin', async () => {
    process.env.FRONTEND_ORIGIN = 'https://thejobbook.app'
    const token = createSessionToken(USER_ID, TEST_SECRET)

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { Origin: 'https://thejobbook.app', Cookie: `pilot_session=${token}` },
    })

    expect(res.headers['access-control-allow-origin']).toBe('https://thejobbook.app')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('does not echo CORS headers for a disallowed origin', async () => {
    process.env.FRONTEND_ORIGIN = 'https://thejobbook.app'

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { Origin: 'https://evil.example.com' },
    })

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows requests with no Origin header (same-origin / server-to-server)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })
})
