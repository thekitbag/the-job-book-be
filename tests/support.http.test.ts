// Founder Support Mode: INTERNAL-gated, GET-only /api/internal/support/*
// endpoints with server-side audit. Normal users must never gain cross-user
// access; support responses must never serialize auth secrets.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const ADMIN_ID = 'sup-admin-1'
const PILOT_ID = 'sup-pilot-1'
const JOB_ID = 'sup-job-1'
const PHOTO_ID = 'sup-photo-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    job: { findUnique: vi.fn(), findMany: vi.fn() },
    rawNote: { findMany: vi.fn(), groupBy: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    reviewDecision: { findMany: vi.fn() },
    memoryItem: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    jobBudgetCategory: { findMany: vi.fn(), findFirst: vi.fn() },
    jobPhoto: { findMany: vi.fn(), findFirst: vi.fn() },
    queueItem: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    supportAuditEvent: { create: vi.fn(), findFirst: vi.fn() },
  },
}))

function makeUser(overrides?: object) {
  return {
    id: PILOT_ID, email: 'mike@pilot.local', name: 'Mike', role: 'PILOT',
    passwordHash: 'bcrypt$secret-hash', createdAt: new Date('2026-06-01T09:00:00.000Z'),
    updatedAt: new Date('2026-06-01T09:00:00.000Z'), ...overrides,
  }
}
const admin = () => makeUser({ id: ADMIN_ID, email: 'founder@thejobbook.local', name: 'Founder', role: 'INTERNAL' })

function makeJob(overrides?: object) {
  return {
    id: JOB_ID, ownerUserId: PILOT_ID, title: 'Garden Room Build', jobType: 'construction',
    status: 'ACTIVE', roughLocationOrLabel: null, notes: null,
    createdAt: new Date('2026-06-10T09:00:00.000Z'), updatedAt: new Date('2026-07-01T09:00:00.000Z'),
    ...overrides,
  }
}

function makePhotoRow(overrides?: object) {
  return {
    id: PHOTO_ID, jobId: JOB_ID, uploadedByUserId: PILOT_ID, descriptor: 'receipt',
    storageKey: `jobs/${JOB_ID}/photos/${PHOTO_ID}`, bucket: 'fake', mimeType: 'image/png', sizeBytes: 3,
    linkedNoteId: null, linkedMemoryItemId: null,
    uploadedAt: new Date('2026-07-01T10:00:00.000Z'), createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-01T10:00:00.000Z'), linkedNote: null, linkedMemoryItem: null,
    ...overrides,
  }
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e])

let app: FastifyInstance
let storage: FakeAudioStorage

beforeAll(async () => {
  storage = new FakeAudioStorage()
  app = buildApp({ storage, transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(async () => {
  vi.clearAllMocks()
  storage.clear()
  const { prisma } = await import('../src/db/client.js')
  // Auth resolves the caller; support target lookups use the same mock.
  vi.mocked(prisma.user.findUnique as any).mockImplementation(async ({ where }: any) =>
    where.id === ADMIN_ID ? admin() : where.id === PILOT_ID ? makeUser() : null)
  vi.mocked(prisma.user.findMany as any).mockResolvedValue([admin(), makeUser()])
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.job.findMany as any).mockResolvedValue([
    { ...makeJob(), _count: { rawNotes: 0, memoryItems: 0, photos: 0 } },
  ])
  vi.mocked(prisma.rawNote.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.rawNote.groupBy as any).mockResolvedValue([])
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.reviewDecision.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
  vi.mocked((prisma as any).supportAuditEvent.create).mockImplementation(async ({ data }: any) => ({ id: 'audit-1', createdAt: new Date(), ...data }))
  vi.mocked((prisma as any).supportAuditEvent.findFirst).mockResolvedValue(null)
})

const asAdmin = { 'x-pilot-user-id': ADMIN_ID }
const asPilot = { 'x-pilot-user-id': PILOT_ID }

const SUPPORT_READS = [
  '/api/internal/support/users',
  `/api/internal/support/users/${PILOT_ID}/jobs`,
  `/api/internal/support/jobs/${JOB_ID}/inspection`,
  `/api/internal/support/jobs/${JOB_ID}/memory-view`,
  `/api/internal/support/jobs/${JOB_ID}/budget-summary`,
  `/api/internal/support/jobs/${JOB_ID}/review-queue`,
  `/api/internal/support/jobs/${JOB_ID}/photos`,
  `/api/internal/support/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`,
]

async function auditActions() {
  const { prisma } = await import('../src/db/client.js')
  return vi.mocked((prisma as any).supportAuditEvent.create).mock.calls.map((c: any) => c[0].data)
}

describe('support guard', () => {
  it('returns 401 for unauthenticated callers on every support route', async () => {
    for (const url of SUPPORT_READS) {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-pilot-user-id': 'ghost' } })
      expect(res.statusCode, url).toBe(401)
    }
  })

  it('returns 403 for authenticated non-internal users on every support route', async () => {
    for (const url of SUPPORT_READS) {
      const res = await app.inject({ method: 'GET', url, headers: asPilot })
      expect(res.statusCode, url).toBe(403)
      expect(res.json().code, url).toBe('FORBIDDEN')
    }
    // no data-shape leakage and no audit rows for refused access
    expect(await auditActions()).toHaveLength(0)
  })

  it('exposes no support write routes (POST/PATCH/PUT/DELETE → 404/405)', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      for (const url of SUPPORT_READS) {
        const res = await app.inject({ method, url, headers: { ...asAdmin, 'content-type': 'application/json' }, payload: {} })
        expect([404, 405], `${method} ${url} → ${res.statusCode}`).toContain(res.statusCode)
      }
    }
  })
})

describe('GET /api/internal/support/users', () => {
  it('lists users with role, job count, and activity — never auth secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/internal/support/users', headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const { users } = res.json()
    expect(users).toHaveLength(2)
    const pilot = users.find((u: any) => u.id === PILOT_ID)
    expect(pilot).toMatchObject({ email: 'mike@pilot.local', name: 'Mike', role: 'PILOT' })
    expect(typeof pilot.jobCount).toBe('number')
    expect('lastActivityAt' in pilot).toBe(true)
    expect(JSON.stringify(res.json())).not.toContain('secret-hash')
    expect(pilot).not.toHaveProperty('passwordHash')
  })

  it('writes a support_users_listed audit row', async () => {
    await app.inject({ method: 'GET', url: '/api/internal/support/users', headers: asAdmin })
    const actions = await auditActions()
    expect(actions).toContainEqual(expect.objectContaining({ adminUserId: ADMIN_ID, action: 'support_users_listed' }))
  })
})

describe('GET /api/internal/support/users/:targetUserId/jobs', () => {
  it('returns the target user summary and jobs with counts', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findMany as any).mockResolvedValue([{
      ...makeJob(),
      _count: { rawNotes: 3, memoryItems: 2, photos: 1 },
    }])
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/users/${PILOT_ID}/jobs`, headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toMatchObject({ id: PILOT_ID, role: 'PILOT' })
    expect(body.user).not.toHaveProperty('passwordHash')
    expect(body.jobs[0]).toMatchObject({
      id: JOB_ID,
      ownerUserId: PILOT_ID,
      title: 'Garden Room Build',
      counts: { notes: 3, memoryItems: 2, reviewItems: 0, photos: 1 },
    })
  })

  it('404s for an unknown target user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/internal/support/users/nobody/jobs', headers: asAdmin })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('USER_NOT_FOUND')
  })

  it('writes a support_user_jobs_viewed audit row with the target user', async () => {
    await app.inject({ method: 'GET', url: `/api/internal/support/users/${PILOT_ID}/jobs`, headers: asAdmin })
    expect(await auditActions()).toContainEqual(
      expect.objectContaining({ action: 'support_user_jobs_viewed', targetUserId: PILOT_ID }),
    )
  })
})

describe('GET /api/internal/support/jobs/:jobId/inspection', () => {
  it("inspects another user's job and includes owner summary and photos", async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([makePhotoRow()])
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/inspection`, headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.job.id).toBe(JOB_ID)
    expect(body.owner).toMatchObject({ id: PILOT_ID, email: 'mike@pilot.local', role: 'PILOT' })
    expect(body.owner).not.toHaveProperty('passwordHash')
    expect(body.notesByDay).toEqual([])
    expect(body.queue.sections.length).toBeGreaterThan(0)
    expect(body.photos[0]).toMatchObject({ id: PHOTO_ID, descriptor: 'receipt' })
    expect(body.photos[0]).not.toHaveProperty('storageKey')
  })

  it('404s for an unknown job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/nope/inspection`, headers: asAdmin })
    expect(res.statusCode).toBe(404)
  })

  it('writes a support_job_inspected audit row and fails closed if the audit write fails', async () => {
    const { prisma } = await import('../src/db/client.js')
    await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/inspection`, headers: asAdmin })
    expect(await auditActions()).toContainEqual(
      expect.objectContaining({ action: 'support_job_inspected', targetUserId: PILOT_ID, targetJobId: JOB_ID }),
    )

    vi.mocked((prisma as any).supportAuditEvent.create).mockRejectedValue(new Error('audit db down'))
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/inspection`, headers: asAdmin })
    expect(res.statusCode).toBe(500)
  })
})

describe('support view-as read endpoints', () => {
  it('memory-view matches the normal read shape for the target user', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/memory-view`, headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Same core shape the pilot's own workspace consumes
    expect(body.job.id).toBe(JOB_ID)
    expect(body.sections.map((s: any) => s.key)).toContain('labour')
    expect(body).toHaveProperty('costSummary.totalKnownCost')
    expect(body).toHaveProperty('labourHoursSummary')
    expect(body).toHaveProperty('stillToCheck')
  })

  it('budget-summary and review-queue return their normal shapes', async () => {
    const budget = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/budget-summary`, headers: asAdmin })
    expect(budget.statusCode).toBe(200)
    expect(budget.json()).toMatchObject({ jobId: JOB_ID })
    expect(budget.json()).toHaveProperty('totals')
    expect(budget.json()).toHaveProperty('labour')

    const queue = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/review-queue`, headers: asAdmin })
    expect(queue.statusCode).toBe(200)
    expect(queue.json()).toHaveProperty('sections')
    expect(queue.json()).toHaveProperty('alreadyRemembered')
  })

  it('lists the target job photos and streams photo bytes with the stored MIME', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([makePhotoRow()])
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, PNG_BYTES, 'image/png')

    const list = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/photos`, headers: asAdmin })
    expect(list.statusCode).toBe(200)
    expect(list.json().photos[0]).toMatchObject({ id: PHOTO_ID, mimeType: 'image/png' })
    expect(list.json().photos[0]).not.toHaveProperty('storageKey')

    const file = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`, headers: asAdmin })
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.rawPayload.equals(PNG_BYTES)).toBe(true)
  })

  it('support photo responses return the support-authenticated imageUrl, and that URL streams bytes for the internal user', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([makePhotoRow()])
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, PNG_BYTES, 'image/png')

    const supportUrl = `/api/internal/support/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`

    const list = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/photos`, headers: asAdmin })
    expect(list.json().photos[0].imageUrl).toBe(supportUrl)

    // inspection photos carry the same support imageUrl
    const inspection = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/inspection`, headers: asAdmin })
    expect(inspection.json().photos[0].imageUrl).toBe(supportUrl)

    // the returned URL is directly loadable by the internal user
    const file = await app.inject({ method: 'GET', url: list.json().photos[0].imageUrl, headers: asAdmin })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(PNG_BYTES)).toBe(true)
  })

  it('404s when the photo does not belong to the job', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/photos/foreign/file`, headers: asAdmin })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_NOT_FOUND')
  })

  it('logs support_view_as_started on the first workspace read and support_view_as_read on subsequent reads', async () => {
    const { prisma } = await import('../src/db/client.js')
    await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/memory-view`, headers: asAdmin })
    let actions = await auditActions()
    expect(actions).toContainEqual(expect.objectContaining({
      action: 'support_view_as_started', targetJobId: JOB_ID, targetUserId: PILOT_ID,
    }))

    // A recent view-as row exists now → the next read is a plain read event
    vi.mocked((prisma as any).supportAuditEvent.findFirst).mockResolvedValue({
      id: 'audit-1', adminUserId: ADMIN_ID, targetJobId: JOB_ID, action: 'support_view_as_started', createdAt: new Date(),
    })
    await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/budget-summary`, headers: asAdmin })
    actions = await auditActions()
    expect(actions).toContainEqual(expect.objectContaining({ action: 'support_view_as_read', targetJobId: JOB_ID }))
  })

  it('audit metadata stays small and secret-free', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, PNG_BYTES, 'image/png')
    await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`, headers: asAdmin })
    for (const row of await auditActions()) {
      const serialized = JSON.stringify(row)
      expect(serialized).not.toContain('secret-hash')
      expect(serialized).not.toContain('storageKey')
      expect(serialized).not.toContain(`jobs/${JOB_ID}/photos`)
      expect(serialized.length).toBeLessThan(600)
    }
  })
})

describe('normal-route boundary is unchanged', () => {
  it("an internal user still cannot write to another user's data through normal routes", async () => {
    const { prisma } = await import('../src/db/client.js')
    // Normal PATCH route: job owned by the pilot, caller is the internal admin
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue({ id: 'm1', jobId: JOB_ID })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${JOB_ID}/memory-items/m1`,
      headers: { ...asAdmin, 'content-type': 'application/json' },
      payload: { memoryType: 'labour', summary: 'hijack' },
    })
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(prisma.memoryItem.update as any)).not.toHaveBeenCalled()
  })

  it("a normal user's own read routes still reject other users' jobs", async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: 'someone-else' }))
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers: asPilot })
    expect(res.statusCode).toBe(403)
  })
})
