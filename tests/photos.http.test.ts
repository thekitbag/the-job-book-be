// Photos in the job record: private upload/list/file/patch APIs. Photos are
// job context only — never spend, memory, or extraction input.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'ph-user-1'
const OTHER_USER_ID = 'ph-user-2'
const JOB_ID = 'ph-job-1'
const NOTE_ID = 'ph-note-1'
const MEMORY_ID = 'ph-memory-1'
const PHOTO_ID = 'ph-photo-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: { findFirst: vi.fn() },
    memoryItem: { findFirst: vi.fn(), create: vi.fn() },
    candidateFact: { create: vi.fn() },
    reviewDecision: { create: vi.fn() },
    jobPhoto: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}))

function makeUser(overrides?: object) {
  return { id: USER_ID, email: 'p@t.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makeJob(overrides?: object) {
  return { id: JOB_ID, ownerUserId: USER_ID, title: 'Job', jobType: 'garden_room', status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(), ...overrides }
}
function makePhotoRow(overrides?: object) {
  return {
    id: PHOTO_ID,
    jobId: JOB_ID,
    uploadedByUserId: USER_ID,
    descriptor: null as string | null,
    storageKey: `jobs/${JOB_ID}/photos/${PHOTO_ID}`,
    bucket: 'fake',
    mimeType: 'image/jpeg',
    sizeBytes: 3,
    linkedNoteId: null as string | null,
    linkedMemoryItemId: null as string | null,
    uploadedAt: new Date('2026-07-08T10:00:00.000Z'),
    createdAt: new Date('2026-07-08T10:00:00.000Z'),
    updatedAt: new Date('2026-07-08T10:00:00.000Z'),
    linkedNote: null as object | null,
    linkedMemoryItem: null as object | null,
    ...overrides,
  }
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff])

function photoForm(opts?: {
  fields?: Record<string, string>
  file?: { buffer: Buffer; mimeType: string } | null
}) {
  const boundary = 'PhotoTestBoundary1a2b3c'
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(opts?.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  const file = opts?.file === undefined ? { buffer: JPEG_BYTES, mimeType: 'image/jpeg' } : opts.file
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="receipt.jpg"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
    ))
    parts.push(file.buffer)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
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
  vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(null)
  vi.mocked((prisma as any).jobPhoto.create).mockImplementation(async ({ data, include }: any) => ({
    ...makePhotoRow(),
    ...data,
    linkedNote: null,
    linkedMemoryItem: null,
  }))
  vi.mocked((prisma as any).jobPhoto.update).mockImplementation(async ({ data }: any) => ({
    ...makePhotoRow(),
    ...data,
    linkedNote: null,
    linkedMemoryItem: null,
  }))
})

const headers = { 'x-pilot-user-id': USER_ID }

function upload(opts?: Parameters<typeof photoForm>[0], userId = USER_ID) {
  const form = photoForm(opts)
  return app.inject({
    method: 'POST',
    url: `/api/jobs/${JOB_ID}/photos`,
    headers: { 'x-pilot-user-id': userId, 'content-type': form.contentType },
    payload: form.payload,
  })
}

describe('POST /api/jobs/:jobId/photos', () => {
  it('uploads a photo-only image and returns a safe JobPhoto shape', async () => {
    const res = await upload()
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({
      jobId: JOB_ID,
      descriptor: null,
      mimeType: 'image/jpeg',
      linkedNoteId: null,
      linkedMemoryItemId: null,
      linkedNote: null,
      linkedMemoryItem: null,
    })
    expect(body.imageUrl).toBe(`/api/jobs/${JOB_ID}/photos/${body.id}/file`)
    // never leak storage internals
    expect(body).not.toHaveProperty('storageKey')
    expect(body).not.toHaveProperty('bucket')
    expect(body).not.toHaveProperty('uploadedByUserId')
  })

  it('stores the bytes under a job/photo-prefixed key not derived from the filename', async () => {
    const res = await upload()
    expect(res.statusCode).toBe(201)
    const keys = [...storage.stored.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(new RegExp(`^jobs/${JOB_ID}/photos/[0-9a-f-]+$`))
    expect(keys[0]).not.toContain('receipt')
  })

  it('trims the descriptor and stores blank as null', async () => {
    const { prisma } = await import('../src/db/client.js')
    let res = await upload({ fields: { descriptor: '  boiler receipt  ' } })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked((prisma as any).jobPhoto.create).mock.calls[0][0].data.descriptor).toBe('boiler receipt')

    res = await upload({ fields: { descriptor: '   ' } })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked((prisma as any).jobPhoto.create).mock.calls[1][0].data.descriptor).toBeNull()
  })

  it('rejects a descriptor over 120 characters', async () => {
    const res = await upload({ fields: { descriptor: 'x'.repeat(121) } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('rejects a missing photo file with 400 MISSING_FIELD', async () => {
    const res = await upload({ file: null })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('rejects an empty file', async () => {
    const res = await upload({ file: { buffer: Buffer.alloc(0), mimeType: 'image/jpeg' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('rejects a non-image MIME with 415 PHOTO_UNSUPPORTED_TYPE', async () => {
    const res = await upload({ file: { buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' } })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('PHOTO_UNSUPPORTED_TYPE')
  })

  it('accepts png, webp, heic, and heif', async () => {
    for (const mimeType of ['image/png', 'image/webp', 'image/heic', 'image/heif']) {
      const res = await upload({ file: { buffer: JPEG_BYTES, mimeType } })
      expect(res.statusCode, mimeType).toBe(201)
      expect(res.json().mimeType).toBe(mimeType)
    }
  })

  it('rejects a photo above 15 MB with 413 PHOTO_TOO_LARGE', async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 1, 1)
    const res = await upload({ file: { buffer: big, mimeType: 'image/jpeg' } })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('PHOTO_TOO_LARGE')
  })

  it('links to a raw note in the same job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.rawNote.findFirst as any).mockResolvedValue({ id: NOTE_ID, jobId: JOB_ID })
    const res = await upload({ fields: { linkedNoteId: NOTE_ID } })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked((prisma as any).jobPhoto.create).mock.calls[0][0].data.linkedNoteId).toBe(NOTE_ID)
    expect(vi.mocked(prisma.rawNote.findFirst as any)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NOTE_ID, jobId: JOB_ID } }),
    )
  })

  it('links to a memory item in the same job', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue({ id: MEMORY_ID, jobId: JOB_ID })
    const res = await upload({ fields: { linkedMemoryItemId: MEMORY_ID } })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked((prisma as any).jobPhoto.create).mock.calls[0][0].data.linkedMemoryItemId).toBe(MEMORY_ID)
  })

  it('rejects both link targets with 400 INVALID_FIELD', async () => {
    const res = await upload({ fields: { linkedNoteId: NOTE_ID, linkedMemoryItemId: MEMORY_ID } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('rejects a link target that is not in this job with 404 PHOTO_LINK_TARGET_NOT_FOUND', async () => {
    const res = await upload({ fields: { linkedNoteId: 'other-job-note' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_LINK_TARGET_NOT_FOUND')
    expect(storage.stored.size).toBe(0)
  })

  it('cleans up the stored object when DB creation fails', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked((prisma as any).jobPhoto.create).mockRejectedValue(new Error('db down'))
    const res = await upload()
    expect(res.statusCode).toBe(500)
    expect(storage.stored.size).toBe(0)
  })

  it('enforces auth and ownership (401 / 403 / 404)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(null)
    expect((await upload(undefined, 'ghost')).statusCode).toBe(401)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser({ id: OTHER_USER_ID }))
    expect((await upload(undefined, OTHER_USER_ID)).statusCode).toBe(403)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)
    expect((await upload()).statusCode).toBe(404)
  })

  it('creates no candidate facts, memory items, or review decisions (receipt is context only)', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await upload({ fields: { descriptor: 'receipt from Jewson £120' } })
    expect(res.statusCode).toBe(201)
    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.memoryItem.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.reviewDecision.create as any)).not.toHaveBeenCalled()
  })
})

describe('GET /api/jobs/:jobId/photos', () => {
  it('lists photos newest first with linked context', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findMany as any).mockResolvedValue([
      makePhotoRow({
        id: 'p2',
        descriptor: 'boiler receipt',
        linkedMemoryItemId: MEMORY_ID,
        linkedMemoryItem: { id: MEMORY_ID, memoryType: 'ORDERED_MATERIAL', summary: '12 sheets plasterboard' },
      }),
      makePhotoRow({
        id: 'p1',
        linkedNoteId: NOTE_ID,
        linkedNote: { id: NOTE_ID, capturedAt: new Date('2026-07-07T09:00:00.000Z') },
      }),
    ])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos`, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.jobId).toBe(JOB_ID)
    expect(body.photos).toHaveLength(2)
    expect(body.photos[0]).toMatchObject({
      id: 'p2',
      descriptor: 'boiler receipt',
      linkedMemoryItem: { id: MEMORY_ID, memoryType: 'ordered_material', summary: '12 sheets plasterboard' },
      imageUrl: `/api/jobs/${JOB_ID}/photos/p2/file`,
    })
    expect(body.photos[1].linkedNote).toEqual({ id: NOTE_ID, capturedAt: '2026-07-07T09:00:00.000Z' })
    expect(body.photos[0]).not.toHaveProperty('storageKey')
    // service must ask for newest-first ordering
    const call = vi.mocked(prisma.jobPhoto.findMany as any).mock.calls[0][0]
    expect(call.orderBy).toMatchObject([{ uploadedAt: 'desc' }, { createdAt: 'desc' }])
  })

  it('enforces ownership on list', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos`, headers })
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /api/jobs/:jobId/photos/:photoId/file', () => {
  it('streams the bytes with the stored MIME type and private cache headers', async () => {
    const { prisma } = await import('../src/db/client.js')
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, JPEG_BYTES, 'image/jpeg')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`, headers })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
    expect(res.rawPayload.equals(JPEG_BYTES)).toBe(true)
  })

  it('returns 404 PHOTO_NOT_FOUND for an unknown photo in the job', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos/nope/file`, headers })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_NOT_FOUND')
  })

  it('returns a safe 404 without leaking the key when the object is missing from storage', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`, headers })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.code).toBe('PHOTO_NOT_FOUND')
    expect(JSON.stringify(body)).not.toContain(`jobs/${JOB_ID}/photos`)
  })

  it('blocks cross-user access to the bytes', async () => {
    const { prisma } = await import('../src/db/client.js')
    await storage.store(`jobs/${JOB_ID}/photos/${PHOTO_ID}`, JPEG_BYTES, 'image/jpeg')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow())
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser({ id: OTHER_USER_ID }))
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: USER_ID }))
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}/file`,
      headers: { 'x-pilot-user-id': OTHER_USER_ID },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /api/jobs/:jobId/photos/:photoId', () => {
  const patchHeaders = { ...headers, 'content-type': 'application/json' }

  beforeEach(async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(makePhotoRow({ descriptor: 'old', linkedNoteId: NOTE_ID }))
  })

  it('updates the descriptor (trimmed) and preserves omitted fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { descriptor: '  new label  ' } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked((prisma as any).jobPhoto.update).mock.calls[0][0]
    expect(call.data.descriptor).toBe('new label')
    expect(call.data.linkedNoteId).toBe(NOTE_ID) // preserved
  })

  it('clears descriptor and links with explicit nulls', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { descriptor: null, linkedNoteId: null } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked((prisma as any).jobPhoto.update).mock.calls[0][0]
    expect(call.data.descriptor).toBeNull()
    expect(call.data.linkedNoteId).toBeNull()
  })

  it('switches the link from note to memory item when the note link is cleared in the same patch', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue({ id: MEMORY_ID, jobId: JOB_ID })
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { linkedNoteId: null, linkedMemoryItemId: MEMORY_ID } })
    expect(res.statusCode).toBe(200)
    const call = vi.mocked((prisma as any).jobPhoto.update).mock.calls[0][0]
    expect(call.data.linkedNoteId).toBeNull()
    expect(call.data.linkedMemoryItemId).toBe(MEMORY_ID)
  })

  it('rejects a patch that would leave both link targets set', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue({ id: MEMORY_ID, jobId: JOB_ID })
    // existing linkedNoteId preserved + new memory link → both set
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { linkedMemoryItemId: MEMORY_ID } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('rejects a patched link target from another job', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { linkedNoteId: 'foreign-note' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_LINK_TARGET_NOT_FOUND')
  })

  it('rejects an over-long descriptor on patch', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { descriptor: 'x'.repeat(121) } })
    expect(res.statusCode).toBe(400)
  })

  it('404s for a photo outside the job and enforces ownership', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.jobPhoto.findFirst as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/other`, headers: patchHeaders, payload: { descriptor: 'x' } })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('PHOTO_NOT_FOUND')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))
    const res2 = await app.inject({ method: 'PATCH', url: `/api/jobs/${JOB_ID}/photos/${PHOTO_ID}`, headers: patchHeaders, payload: { descriptor: 'x' } })
    expect(res2.statusCode).toBe(403)
  })
})
