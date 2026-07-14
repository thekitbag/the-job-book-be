// Correct/remove job items: confirmed memory items are soft-removed from the
// active job record (never hard-deleted, source evidence preserved), all
// active reads exclude removed rows, and used ↔ leftover moves reclassify
// without losing evidence.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'rm-user-1'
const OTHER_USER_ID = 'rm-user-2'
const JOB_ID = 'rm-job-1'
const MEMORY_ID = 'rm-memory-1'
const PHOTO_ID = 'rm-photo-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    memoryItem: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    candidateFact: { findMany: vi.fn(), deleteMany: vi.fn() },
    rawNote: { findMany: vi.fn(), deleteMany: vi.fn() },
    transcript: { deleteMany: vi.fn() },
    reviewDecision: { findMany: vi.fn(), deleteMany: vi.fn() },
    jobBudgetCategory: { findMany: vi.fn(), findFirst: vi.fn() },
    jobPhoto: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    jobPayment: { findMany: vi.fn() },
    queueItem: { findMany: vi.fn() },
  },
}))

function makeUser(overrides?: object) {
  return { id: USER_ID, email: 'p@t.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makeJob(overrides?: object) {
  return {
    id: JOB_ID, ownerUserId: USER_ID, title: 'Job', jobType: 'garden_room', status: 'STARTED',
    roughLocationOrLabel: null, notes: null, customerTotalAmount: null, customerTotalCurrency: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  }
}
function makeMemory(overrides?: object) {
  return {
    id: MEMORY_ID, jobId: JOB_ID, reviewDecisionId: 'rd-1', sourceCandidateFactId: null,
    memoryType: 'ORDERED_MATERIAL', isManual: true, summary: 'timber', materialName: 'timber',
    quantity: '1', unit: 'load', supplierName: null, deliveryTiming: null, locationOrUse: null,
    costAmount: null, costCurrency: 'GBP', costQualifier: null, totalCostAmount: '900',
    labourHours: null, labourPerson: null, labourTask: null, happenedAt: null,
    unresolvedFlags: [], budgetCategoryId: null,
    isRemoved: false, removedAt: null, removedByUserId: null, removedReason: null,
    createdAt: new Date(), updatedAt: new Date(), sourceFact: null,
    ...overrides,
  }
}

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
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
  vi.mocked((prisma.memoryItem as any).update).mockImplementation(async ({ data }: any) => ({ ...makeMemory(), ...data, sourceFact: null }))
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
  vi.mocked((prisma as any).jobPhoto.findMany).mockResolvedValue([])
  vi.mocked((prisma as any).jobPhoto.findFirst).mockResolvedValue(null)
  vi.mocked((prisma as any).jobPhoto.update).mockImplementation(async ({ data }: any) => ({ ...data }))
})

const authHeaders = { 'x-pilot-user-id': USER_ID }
const MI_URL = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}`

describe('DELETE /api/jobs/:jobId/memory-items/:memoryItemId', () => {
  it('soft-removes the item with removal fields and returns 204 — never a hard delete', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory())
    const res = await app.inject({ method: 'DELETE', url: MI_URL, headers: authHeaders })
    expect(res.statusCode).toBe(204)
    const call = vi.mocked((prisma.memoryItem as any).update).mock.calls[0][0]
    expect(call.data.isRemoved).toBe(true)
    expect(call.data.removedAt).toBeInstanceOf(Date)
    expect(call.data.removedByUserId).toBe(USER_ID)
    expect(vi.mocked((prisma.memoryItem as any).delete)).not.toHaveBeenCalled()
  })

  it('preserves source note/transcript/candidate fact/review decision rows', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({ sourceCandidateFactId: 'cf-1' }))
    const res = await app.inject({ method: 'DELETE', url: MI_URL, headers: authHeaders })
    expect(res.statusCode).toBe(204)
    expect(vi.mocked((prisma.rawNote as any).deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked((prisma.transcript as any).deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked((prisma.candidateFact as any).deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked((prisma.reviewDecision as any).deleteMany)).not.toHaveBeenCalled()
  })

  it('looks up only active items: repeat delete and unknown item return 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'DELETE', url: MI_URL, headers: authHeaders })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('MEMORY_ITEM_NOT_FOUND')
    const where = vi.mocked(prisma.memoryItem.findFirst as any).mock.calls[0][0].where
    expect(where).toMatchObject({ id: MEMORY_ID, jobId: JOB_ID, isRemoved: false })
  })

  it('is owner-scoped: non-owner 403, unknown job 404', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'DELETE', url: MI_URL, headers: authHeaders })).statusCode).toBe(403)
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'DELETE', url: MI_URL, headers: authHeaders })).statusCode).toBe(404)
  })
})

describe('active reads exclude removed memory items', () => {
  it('memory-view queries only non-removed items', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers: authHeaders })
    expect(res.statusCode).toBe(200)
    const where = vi.mocked(prisma.memoryItem.findMany as any).mock.calls[0][0].where
    expect(where).toMatchObject({ jobId: JOB_ID, isRemoved: false })
  })

  it('budget-summary queries only non-removed items', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/budget-summary`, headers: authHeaders })
    expect(res.statusCode).toBe(200)
    const where = vi.mocked(prisma.memoryItem.findMany as any).mock.calls[0][0].where
    expect(where).toMatchObject({ jobId: JOB_ID, isRemoved: false })
  })

  it('review-queue alreadyRemembered queries only non-removed items', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).queueItem?.findMany ?? vi.fn()).mockResolvedValue?.([])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: authHeaders })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked(prisma.memoryItem.findMany as any).mock.calls.at(-1)[0]
    expect(call.where).toMatchObject({ jobId: JOB_ID, isRemoved: false })
  })

  it('after removal, spend/labour totals recompute from active rows only', async () => {
    const { prisma } = await import('../src/db/client.js')
    // DB-level filter simulated: only the labour row remains active
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemory({
        id: 'mem-labour', memoryType: 'LABOUR', materialName: null, summary: 'Tom 8h at £35/hr',
        labourHours: '8', labourPerson: 'Tom', costAmount: '35', costQualifier: 'per_hour', totalCostAmount: '280',
      }),
    ])
    const view = (await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/memory-view`, headers: authHeaders })).json()
    expect(view.costSummary.orderedMaterials.knownSpendAmount).toBeNull()
    expect(view.costSummary.labour.knownSpendAmount).toBe('280')
    expect(view.costSummary.totalKnownCost.knownSpendAmount).toBe('280')
    expect(view.labourHoursSummary.totalHours).toBe('8')
  })
})

describe('PATCH on removed items and used ↔ leftover moves', () => {
  const patchHeaders = { ...authHeaders, 'content-type': 'application/json' }

  it('a removed item cannot be patched through the normal endpoint (404)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null) // active-only lookup misses it
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers: patchHeaders, payload: { memoryType: 'used_material', summary: 'x' } })
    expect(res.statusCode).toBe(404)
    const where = vi.mocked(prisma.memoryItem.findFirst as any).mock.calls[0][0].where
    expect(where).toMatchObject({ isRemoved: false })
  })

  it('moves used → leftover preserving source evidence', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({
      memoryType: 'USED_MATERIAL', materialName: 'OSB', totalCostAmount: null, sourceCandidateFactId: 'cf-1',
    }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers: patchHeaders, payload: { memoryType: 'leftover_material', summary: '3 OSB sheets left' } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma.memoryItem as any).update).mock.calls[0][0].data
    expect(data.memoryType).toBe('LEFTOVER_MATERIAL')
    expect('sourceCandidateFactId' in data).toBe(false) // source link untouched
  })

  it('moves leftover → used and clears a stale budget category', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(makeMemory({
      memoryType: 'ORDERED_MATERIAL', materialName: 'OSB', budgetCategoryId: 'cat-1',
    }))
    const res = await app.inject({ method: 'PATCH', url: MI_URL, headers: patchHeaders, payload: { memoryType: 'used_material', summary: 'Used 3 OSB sheets' } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked((prisma.memoryItem as any).update).mock.calls[0][0].data
    expect(data.memoryType).toBe('USED_MATERIAL')
    expect(data.budgetCategoryId).toBeNull() // used material must not carry a category
  })
})

describe('DELETE /api/jobs/:jobId/photos/:photoId — soft delete', () => {
  const PHOTO_URL = `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`
  function makePhotoRow(overrides?: object) {
    return {
      id: PHOTO_ID, jobId: JOB_ID, uploadedByUserId: USER_ID, descriptor: null,
      storageKey: `jobs/${JOB_ID}/photos/${PHOTO_ID}`, bucket: 'fake', mimeType: 'image/png', sizeBytes: 3,
      linkedNoteId: null, linkedMemoryItemId: null, isDeleted: false, deletedAt: null, deletedByUserId: null,
      uploadedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      linkedNote: null, linkedMemoryItem: null, ...overrides,
    }
  }

  it('soft-deletes the photo without touching the stored object and returns 204', async () => {
    const { prisma } = await import('../src/db/client.js')
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, Buffer.from([1]), 'image/png')
    vi.mocked((prisma as any).jobPhoto.findFirst).mockResolvedValue(makePhotoRow())
    const res = await app.inject({ method: 'DELETE', url: PHOTO_URL, headers: authHeaders })
    expect(res.statusCode).toBe(204)
    const call = vi.mocked((prisma as any).jobPhoto.update).mock.calls[0][0]
    expect(call.data.isDeleted).toBe(true)
    expect(call.data.deletedAt).toBeInstanceOf(Date)
    expect(call.data.deletedByUserId).toBe(USER_ID)
    // R2/local object is not physically deleted in this slice
    expect(storage.stored.size).toBe(1)
    expect(vi.mocked((prisma as any).jobPhoto.delete)).not.toHaveBeenCalled()
  })

  it('repeat delete returns 404 and the lookup is active-only', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPhoto.findFirst).mockResolvedValue(null)
    const res = await app.inject({ method: 'DELETE', url: PHOTO_URL, headers: authHeaders })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_NOT_FOUND')
    const where = vi.mocked((prisma as any).jobPhoto.findFirst).mock.calls[0][0].where
    expect(where).toMatchObject({ id: PHOTO_ID, jobId: JOB_ID, isDeleted: false })
  })

  it('list and file routes exclude deleted photos', async () => {
    const { prisma } = await import('../src/db/client.js')
    const list = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos`, headers: authHeaders })
    expect(list.statusCode).toBe(200)
    const listWhere = vi.mocked((prisma as any).jobPhoto.findMany).mock.calls[0][0].where
    expect(listWhere).toMatchObject({ jobId: JOB_ID, isDeleted: false })

    vi.mocked((prisma as any).jobPhoto.findFirst).mockResolvedValue(null)
    const file = await app.inject({ method: 'GET', url: `${PHOTO_URL}/file`, headers: authHeaders })
    expect(file.statusCode).toBe(404)
    const fileWhere = vi.mocked((prisma as any).jobPhoto.findFirst).mock.calls[0][0].where
    expect(fileWhere).toMatchObject({ isDeleted: false })
  })

  it('is owner-scoped', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    expect((await app.inject({ method: 'DELETE', url: PHOTO_URL, headers: authHeaders })).statusCode).toBe(403)
  })
})

describe('support and inspection', () => {
  const ADMIN_ID = 'rm-admin-1'
  const asAdmin = { 'x-pilot-user-id': ADMIN_ID }

  beforeEach(async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.user.findUnique as any).mockImplementation(async ({ where }: any) =>
      where.id === ADMIN_ID ? makeUser({ id: ADMIN_ID, role: 'INTERNAL' }) : makeUser())
    ;(prisma as any).supportAuditEvent = {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'a1', createdAt: new Date(), ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
    }
    vi.mocked(prisma.rawNote.findMany as any).mockResolvedValue([])
    vi.mocked(prisma.reviewDecision.findMany as any).mockResolvedValue([])
  })

  it('support view-as memory-view uses the same active-only filter as the user view', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/memory-view`, headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const where = vi.mocked(prisma.memoryItem.findMany as any).mock.calls[0][0].where
    expect(where).toMatchObject({ isRemoved: false })
  })

  it('support inspection includes removed items clearly marked', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockImplementation(async ({ where }: any) =>
      where.isRemoved === false
        ? [] // active reads (photos summary etc.)
        : [makeMemory(), makeMemory({ id: 'rm-memory-2', isRemoved: true, removedAt: new Date('2026-07-14T09:00:00.000Z') })])
    const res = await app.inject({ method: 'GET', url: `/api/internal/support/jobs/${JOB_ID}/inspection`, headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const items = res.json().memoryItems
    expect(items).toHaveLength(2)
    const removed = items.find((m: any) => m.id === 'rm-memory-2')
    expect(removed.isRemoved).toBe(true)
    expect(removed.removedAt).toBe('2026-07-14T09:00:00.000Z')
    expect(items.find((m: any) => m.id === MEMORY_ID).isRemoved).toBe(false)
  })
})
