// Job contacts and the job-level site address: job-local "who is involved"
// context, edited from Job details. Contacts are not CRM — they are scoped to
// one job, owner-only, soft-deleted, and never created from voice. Real DB.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { DevEmailProvider } from '../src/email/index.js'

const EMAIL_PREFIX = 'job-contacts-test-'
const TEST_SECRET = 'test-session-secret-long-enough!!'

let app: FastifyInstance
let savedEnv: Record<string, string | undefined>

let userAId: string
let cookieA: string
let cookieB: string
let jobId: string
let otherJobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: ids } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.jobContact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
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

function getDetails(cookie = cookieA, job = () => jobId) {
  return app.inject({ method: 'GET', url: `/api/jobs/${job()}/details`, headers: { cookie } })
}

function patchDetails(payload: object, cookie = cookieA, job = () => jobId) {
  return app.inject({ method: 'PATCH', url: `/api/jobs/${job()}/details`, headers: json(cookie), payload })
}

function createContact(payload: object, cookie = cookieA, job = () => jobId) {
  return app.inject({ method: 'POST', url: `/api/jobs/${job()}/contacts`, headers: json(cookie), payload })
}

function patchContact(contactId: string, payload: object, cookie = cookieA, job = () => jobId) {
  return app.inject({
    method: 'PATCH',
    url: `/api/jobs/${job()}/contacts/${contactId}`,
    headers: json(cookie),
    payload,
  })
}

function deleteContact(contactId: string, cookie = cookieA, job = () => jobId) {
  return app.inject({
    method: 'DELETE',
    url: `/api/jobs/${job()}/contacts/${contactId}`,
    headers: { cookie },
  })
}

async function newContact(payload: object = { name: 'Sue Adams' }) {
  const res = await createContact(payload)
  expect(res.statusCode).toBe(201)
  return res.json()
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
  const jobB = await prisma.job.create({
    data: { ownerUserId: userB.id, title: 'User B loft', jobType: 'extension' },
  })
  otherJobId = jobB.id
})

afterAll(async () => {
  await cleanup()
  await app.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// Fresh job per test so contact lists and ordering are independent.
beforeEach(async () => {
  const job = await prisma.job.create({
    data: { ownerUserId: userAId, title: 'Poole garden room', jobType: 'garden_room' },
  })
  jobId = job.id
})

describe('GET /api/jobs/:jobId/details', () => {
  it('returns the job with no contacts and a null site address', async () => {
    const res = await getDetails()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.job).toMatchObject({
      id: jobId,
      title: 'Poole garden room',
      jobType: 'garden_room',
      // schema default: a job created without an explicit status is started
      status: 'started',
      roughLocationOrLabel: null,
      siteAddress: null,
    })
    expect(body.job.createdAt).toBeTruthy()
    expect(body.job.updatedAt).toBeTruthy()
    expect(body.contacts).toEqual([])
    // no auth/ownership internals on the wire
    expect(body.job).not.toHaveProperty('ownerUserId')
  })

  it('lists live contacts in sort order', async () => {
    await newContact({ name: 'Sue Adams' })
    await newContact({ name: 'Dave the sparky' })

    const body = (await getDetails()).json()
    expect(body.contacts.map((c: { name: string }) => c.name)).toEqual(['Sue Adams', 'Dave the sparky'])
    expect(body.contacts.map((c: { sortOrder: number }) => c.sortOrder)).toEqual([0, 1])
  })

  it('404s for a job that does not exist', async () => {
    const res = await getDetails(cookieA, () => '00000000-0000-0000-0000-0000000000ff')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('JOB_NOT_FOUND')
  })
})

describe('PATCH /api/jobs/:jobId/details', () => {
  it('sets and trims the site address, returning the details shape', async () => {
    const res = await patchDetails({ siteAddress: '  12 Sandbanks Road, Poole, BH14 8AQ  ' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.job.siteAddress).toBe('12 Sandbanks Road, Poole, BH14 8AQ')
    expect(body.contacts).toEqual([])
    expect((await getDetails()).json().job.siteAddress).toBe('12 Sandbanks Road, Poole, BH14 8AQ')
  })

  it('clears the site address with null and with a blank string', async () => {
    await patchDetails({ siteAddress: '12 Sandbanks Road' })
    expect((await patchDetails({ siteAddress: null })).json().job.siteAddress).toBeNull()

    await patchDetails({ siteAddress: '12 Sandbanks Road' })
    expect((await patchDetails({ siteAddress: '   ' })).json().job.siteAddress).toBeNull()
  })

  it('rejects a site address over 240 characters', async () => {
    const res = await patchDetails({ siteAddress: 'x'.repeat(241) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('400s when no site address field is supplied', async () => {
    const res = await patchDetails({})
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('does not touch roughLocationOrLabel', async () => {
    await prisma.job.update({ where: { id: jobId }, data: { roughLocationOrLabel: 'Poole' } })
    const body = (await patchDetails({ siteAddress: '12 Sandbanks Road' })).json()
    expect(body.job.roughLocationOrLabel).toBe('Poole')
    expect(body.job.siteAddress).toBe('12 Sandbanks Road')
  })
})

describe('POST /api/jobs/:jobId/contacts', () => {
  it('creates a name-only contact with null optional fields', async () => {
    const res = await createContact({ name: '  Sue Adams  ' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      jobId,
      name: 'Sue Adams',
      role: null,
      phone: null,
      email: null,
      note: null,
      sortOrder: 0,
    })
    const contact = res.json()
    expect(contact.id).toBeTruthy()
    expect(contact.createdAt).toBeTruthy()
    expect(contact.updatedAt).toBeTruthy()
    // internal audit columns stay internal
    expect(contact).not.toHaveProperty('createdByUserId')
    expect(contact).not.toHaveProperty('isDeleted')
    expect(contact).not.toHaveProperty('deletedByUserId')
  })

  it('creates a full contact and lowercases the email', async () => {
    const res = await createContact({
      name: 'Sue Adams',
      role: ' Customer ',
      phone: ' 07700 900123 ',
      email: '  Sue.Adams@Example.com ',
      note: ' Prefers texts after 5pm ',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      name: 'Sue Adams',
      role: 'Customer',
      phone: '07700 900123',
      email: 'sue.adams@example.com',
      note: 'Prefers texts after 5pm',
    })
  })

  it('treats blank optional fields as null', async () => {
    const res = await createContact({ name: 'Sue', role: '  ', phone: '', email: null, note: '   ' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ role: null, phone: null, email: null, note: null })
  })

  it('requires a name', async () => {
    expect((await createContact({})).statusCode).toBe(400)
    expect((await createContact({})).json().code).toBe('MISSING_FIELD')
    expect((await createContact({ name: '   ' })).statusCode).toBe(400)
    expect((await createContact({ name: '   ' })).json().code).toBe('INVALID_FIELD')
  })

  it('enforces field length caps', async () => {
    const cases: Array<[string, object]> = [
      ['name', { name: 'x'.repeat(81) }],
      ['role', { name: 'Sue', role: 'x'.repeat(61) }],
      ['phone', { name: 'Sue', phone: '1'.repeat(41) }],
      ['email', { name: 'Sue', email: `${'x'.repeat(112)}@test.com` }],
      ['note', { name: 'Sue', note: 'x'.repeat(241) }],
    ]
    for (const [field, payload] of cases) {
      const res = await createContact(payload)
      expect(res.statusCode, field).toBe(400)
      expect(res.json().code).toBe('INVALID_FIELD')
    }
  })

  it('rejects obviously invalid emails', async () => {
    for (const email of ['not-an-email', 'sue at example.com', 'sue@ example.com', 'sue@@example.com']) {
      const res = await createContact({ name: 'Sue', email })
      expect(res.statusCode, email).toBe(400)
      expect(res.json().code).toBe('INVALID_FIELD')
    }
  })

  it('accepts practical builder phone formats', async () => {
    for (const phone of ['07700 900123', '+44 7700 900123', '(01202) 555-0134', '01202555013']) {
      const res = await createContact({ name: 'Dave', phone })
      expect(res.statusCode, phone).toBe(201)
      expect(res.json().phone).toBe(phone)
    }
  })

  it('rejects phone text that is not a phone number', async () => {
    const res = await createContact({ name: 'Dave', phone: 'call the office' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })
})

describe('PATCH /api/jobs/:jobId/contacts/:contactId', () => {
  it('preserves omitted fields', async () => {
    const contact = await newContact({
      name: 'Sue Adams',
      role: 'Customer',
      phone: '07700 900123',
      email: 'sue@example.com',
      note: 'Texts only',
    })

    const res = await patchContact(contact.id, { name: 'Sue A' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Sue A',
      role: 'Customer',
      phone: '07700 900123',
      email: 'sue@example.com',
      note: 'Texts only',
    })
  })

  it('clears optional fields with null or blank', async () => {
    const contact = await newContact({
      name: 'Sue Adams',
      role: 'Customer',
      phone: '07700 900123',
      email: 'sue@example.com',
      note: 'Texts only',
    })

    const res = await patchContact(contact.id, { role: null, phone: '  ', email: null, note: '' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Sue Adams',
      role: null,
      phone: null,
      email: null,
      note: null,
    })
  })

  it('refuses to clear or blank the name', async () => {
    const contact = await newContact()
    for (const payload of [{ name: null }, { name: '   ' }]) {
      const res = await patchContact(contact.id, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('INVALID_FIELD')
    }
    expect((await getDetails()).json().contacts[0].name).toBe('Sue Adams')
  })

  it('applies the same validation as create', async () => {
    const contact = await newContact()
    expect((await patchContact(contact.id, { email: 'nope' })).statusCode).toBe(400)
    expect((await patchContact(contact.id, { note: 'x'.repeat(241) })).statusCode).toBe(400)
  })

  it('400s when no editable field is supplied', async () => {
    const contact = await newContact()
    const res = await patchContact(contact.id, {})
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('404s for a contact id that belongs to another job', async () => {
    const contact = await newContact()
    const otherJob = await prisma.job.create({
      data: { ownerUserId: userAId, title: 'Other job', jobType: 'other' },
    })
    const res = await patchContact(contact.id, { name: 'Nope' }, cookieA, () => otherJob.id)
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('JOB_CONTACT_NOT_FOUND')
  })
})

describe('DELETE /api/jobs/:jobId/contacts/:contactId', () => {
  it('hides the contact from reads and keeps the row for audit', async () => {
    const contact = await newContact()
    const res = await deleteContact(contact.id)
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')

    expect((await getDetails()).json().contacts).toEqual([])
    const row = await prisma.jobContact.findUnique({ where: { id: contact.id } })
    expect(row).toMatchObject({ isDeleted: true, deletedByUserId: userAId })
    expect(row?.deletedAt).toBeTruthy()
  })

  it('404s on a repeat delete and on patching a deleted contact', async () => {
    const contact = await newContact()
    expect((await deleteContact(contact.id)).statusCode).toBe(204)

    const repeat = await deleteContact(contact.id)
    expect(repeat.statusCode).toBe(404)
    expect(repeat.json().code).toBe('JOB_CONTACT_NOT_FOUND')
    expect((await patchContact(contact.id, { name: 'Zombie' })).statusCode).toBe(404)
  })

  it('keeps ordering stable for the remaining contacts', async () => {
    const first = await newContact({ name: 'Sue Adams' })
    await newContact({ name: 'Dave the sparky' })
    await deleteContact(first.id)
    const third = await newContact({ name: 'Building control' })
    expect(third.sortOrder).toBe(2)

    const names = (await getDetails()).json().contacts.map((c: { name: string }) => c.name)
    expect(names).toEqual(['Dave the sparky', 'Building control'])
  })
})

describe('ownership and auth', () => {
  it('rejects unauthenticated access to every contacts route', async () => {
    const contact = await newContact()
    const noAuth = [
      { method: 'GET' as const, url: `/api/jobs/${jobId}/details` },
      { method: 'PATCH' as const, url: `/api/jobs/${jobId}/details` },
      { method: 'POST' as const, url: `/api/jobs/${jobId}/contacts` },
      { method: 'PATCH' as const, url: `/api/jobs/${jobId}/contacts/${contact.id}` },
      { method: 'DELETE' as const, url: `/api/jobs/${jobId}/contacts/${contact.id}` },
    ]
    for (const req of noAuth) {
      const res = await app.inject({ ...req, headers: { 'content-type': 'application/json' }, payload: {} })
      expect(res.statusCode, req.url).toBe(401)
    }
  })

  it('blocks another user from reading or writing job details', async () => {
    expect((await getDetails(cookieB)).statusCode).toBe(403)
    expect((await patchDetails({ siteAddress: 'Theirs' }, cookieB)).statusCode).toBe(403)
    expect((await createContact({ name: 'Intruder' }, cookieB)).statusCode).toBe(403)
  })

  it('blocks another user from patching or deleting a contact', async () => {
    const contact = await newContact()
    expect((await patchContact(contact.id, { name: 'Intruder' }, cookieB)).statusCode).toBe(403)
    expect((await deleteContact(contact.id, cookieB)).statusCode).toBe(403)
    // the contact id is also useless against the intruder's own job
    const viaOwnJob = await patchContact(contact.id, { name: 'Intruder' }, cookieB, () => otherJobId)
    expect(viaOwnJob.statusCode).toBe(404)

    expect((await getDetails()).json().contacts[0].name).toBe('Sue Adams')
  })
})

describe('privacy of error responses', () => {
  it('never echoes a submitted contact value back in an error', async () => {
    const secret = 'sue.adams.private@example.com'
    const res = await createContact({ name: 'Sue', email: `${secret} bad` })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain(secret)
    expect(res.json().message).toBe('email must be a valid email address')

    const long = 'x'.repeat(241)
    const addressRes = await patchDetails({ siteAddress: long })
    expect(addressRes.body).not.toContain(long)
  })
})

describe('existing job endpoints', () => {
  it('still creates jobs without any contact or address fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: json(cookieA),
      payload: { title: 'New shed', jobType: 'other' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ title: 'New shed', siteAddress: null })
  })

  it('exposes siteAddress on the normal job read', async () => {
    await patchDetails({ siteAddress: '12 Sandbanks Road' })
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie: cookieA } })
    expect(res.statusCode).toBe(200)
    expect(res.json().siteAddress).toBe('12 Sandbanks Road')
  })
})
