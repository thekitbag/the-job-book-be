// Real-DB HTTP tests for email/password account auth:
// signup, login, logout, /me, password reset. Uses DATABASE_URL from .env.test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { DevEmailProvider } from '../src/email/index.js'
import { hashResetToken } from '../src/lib/password.js'

const EMAIL_PREFIX = 'authacct-'
const TEST_SECRET = 'test-session-secret-long-enough!!'

let app: FastifyInstance
let emailProvider: DevEmailProvider

function email(local: string) {
  return `${EMAIL_PREFIX}${local}@test.local`
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } })
  await prisma.job.deleteMany({ where: { ownerUserId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

function sessionCookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as string]
  const session = cookies.find((c) => c?.startsWith('jobbook_session='))
  expect(session).toBeDefined()
  return session!.split(';')[0]
}

let savedEnv: Record<string, string | undefined>

beforeAll(async () => {
  savedEnv = {
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    PILOT_USER_ID: process.env.PILOT_USER_ID,
  }
  process.env.SESSION_COOKIE_SECRET = TEST_SECRET
  delete process.env.PILOT_USER_ID // no dev fallback in these tests
  emailProvider = new DevEmailProvider()
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
    email: emailProvider,
  })
  await app.ready()
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await app.close()
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key]
    else process.env[key] = val
  }
})

beforeEach(() => {
  emailProvider.sent = []
})

async function signup(local: string, password = 'correct-horse-battery', name?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'content-type': 'application/json' },
    payload: { email: email(local), password, ...(name ? { name } : {}) },
  })
}

describe('POST /api/auth/signup', () => {
  it('creates an account, sets a session cookie, returns the safe user', async () => {
    const res = await signup('signup1', 'correct-horse-battery', 'Test Builder')
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user).toMatchObject({ email: email('signup1'), name: 'Test Builder', role: 'PILOT' })
    expect(body.user.id).toBeTruthy()
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|scrypt/)
    const setCookie = String(res.headers['set-cookie'])
    expect(setCookie).toMatch(/jobbook_session=/)
    expect(setCookie).toMatch(/HttpOnly/i)
  })

  it('normalizes email to lowercase trimmed form', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: { email: `  ${EMAIL_PREFIX.toUpperCase()}NORM@Test.Local `, password: 'correct-horse-battery' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().user.email).toBe(`${EMAIL_PREFIX}norm@test.local`)
  })

  it('rejects duplicate email with 409, case-insensitively', async () => {
    await signup('dupe')
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('dupe').toUpperCase(), password: 'another-password-1' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'EMAIL_IN_USE' })
  })

  it('rejects short passwords and malformed emails with 400', async () => {
    const short = await signup('short', 'tiny')
    expect(short.statusCode).toBe(400)
    expect(short.json()).toMatchObject({ code: 'INVALID_FIELD' })

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'not-an-email', password: 'correct-horse-battery' },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('session cookie from signup grants access to protected routes', async () => {
    const res = await signup('protected')
    const cookie = sessionCookieOf(res)
    const jobs = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })
    expect(jobs.statusCode).toBe(200)
    expect(jobs.json()).toEqual([])
  })

  it('stores the password as a scrypt hash, never plaintext', async () => {
    await signup('hashed', 'plaintext-password-x')
    const user = await prisma.user.findUnique({ where: { email: email('hashed') } })
    expect(user?.passwordHash).toMatch(/^scrypt\$/)
    expect(user?.passwordHash).not.toContain('plaintext-password-x')
  })
})

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and sets a session cookie', async () => {
    await signup('login1', 'my-real-password-1')
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('login1').toUpperCase(), password: 'my-real-password-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe(email('login1'))
    sessionCookieOf(res)
  })

  it('returns the same generic 401 for wrong password and unknown email', async () => {
    await signup('login2', 'my-real-password-2')
    const wrongPw = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('login2'), password: 'wrong-password-here' },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('no-such-user'), password: 'whatever-password' },
    })
    expect(wrongPw.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrongPw.json()).toEqual(unknown.json())
    expect(wrongPw.headers['set-cookie']).toBeUndefined()
  })
})

describe('GET /api/auth/me', () => {
  it('returns the safe user when authenticated by cookie', async () => {
    const res = await signup('me1')
    const cookie = sessionCookieOf(res)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ email: email('me1') })
    expect(JSON.stringify(me.json())).not.toMatch(/passwordHash|scrypt/)
  })

  it('returns 401 when unauthenticated', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(me.statusCode).toBe(401)
  })
})

describe('POST /api/auth/logout', () => {
  it('clears the new and legacy session cookies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie']
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
    const cleared = cookies.join('\n')
    expect(cleared).toMatch(/jobbook_session=/)
    expect(cleared).toMatch(/pilot_session=/)
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })
})

describe('password reset', () => {
  it('request always returns ok and does not reveal whether the user exists', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('ghost') },
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toEqual({ ok: true })
    expect(emailProvider.sent).toHaveLength(0)

    await signup('reset1')
    emailProvider.sent = []
    const known = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset1') },
    })
    expect(known.statusCode).toBe(200)
    expect(known.json()).toEqual({ ok: true })
    expect(emailProvider.sent).toHaveLength(1)
    expect(emailProvider.sent[0].to).toBe(email('reset1'))
    expect(emailProvider.sent[0].resetUrl).toMatch(/token=/)
  })

  it('stores only a hashed token with an expiry', async () => {
    await signup('reset-hash')
    emailProvider.sent = []
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset-hash') },
    })
    const token = new URL(emailProvider.sent[0].resetUrl).searchParams.get('token')!
    const user = await prisma.user.findUnique({ where: { email: email('reset-hash') } })
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user!.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).not.toBe(token)
    expect(rows[0].tokenHash).toBe(hashResetToken(token))
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('confirm sets the new password: old fails, new works, and the user is logged in', async () => {
    await signup('reset2', 'old-password-abc')
    emailProvider.sent = []
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset2') },
    })
    const token = new URL(emailProvider.sent[0].resetUrl).searchParams.get('token')!

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new-password-xyz' },
    })
    expect(confirm.statusCode).toBe(200)
    expect(confirm.json().user.email).toBe(email('reset2'))
    sessionCookieOf(confirm) // confirm logs the user in

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset2'), password: 'old-password-abc' },
    })
    expect(oldLogin.statusCode).toBe(401)

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset2'), password: 'new-password-xyz' },
    })
    expect(newLogin.statusCode).toBe(200)
  })

  it('tokens are single-use', async () => {
    await signup('reset3', 'old-password-abc')
    emailProvider.sent = []
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset3') },
    })
    const token = new URL(emailProvider.sent[0].resetUrl).searchParams.get('token')!

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new-password-one' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new-password-two' },
    })
    expect(second.statusCode).toBe(400)
    expect(second.json()).toMatchObject({ code: 'RESET_TOKEN_INVALID' })
  })

  it('expired tokens are rejected', async () => {
    await signup('reset4')
    emailProvider.sent = []
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: email('reset4') },
    })
    const token = new URL(emailProvider.sent[0].resetUrl).searchParams.get('token')!
    await prisma.passwordResetToken.updateMany({
      where: { tokenHash: hashResetToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new-password-xyz' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'RESET_TOKEN_INVALID' })
  })

  it('garbage tokens are rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'not-a-real-token', password: 'new-password-xyz' },
    })
    expect(res.statusCode).toBe(400)
  })
})
