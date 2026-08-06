// Receipts in the job log: private receipt/invoice evidence upload, list,
// file, patch, and removal. Receipts are job evidence only — never OCR'd,
// never spend, never Budget/Money/Memory input — and receipt images must never
// appear in the Photos list. Real DB, fake storage.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { DevEmailProvider } from '../src/email/index.js'
import { MAX_RECEIPT_BYTES } from '../src/services/receipts.js'

const EMAIL_PREFIX = 'receipts-test-'
const TEST_SECRET = 'test-session-secret-long-enough!!'

let app: FastifyInstance
let storage: FakeAudioStorage
let savedEnv: Record<string, string | undefined>

let userAId: string
let cookieA: string
let cookieB: string
let jobId: string

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-receipt-bytes')])
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('pdf-invoice-bytes')])

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: ids } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
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

function multipartForm(opts?: {
  fields?: Record<string, string>
  // mimeType null omits the part's Content-Type header entirely, as some
  // phone/file-provider uploads do.
  file?: { buffer: Buffer; mimeType: string | null; filename?: string } | null
  fieldName?: string
}) {
  const boundary = 'ReceiptTestBoundary9z8y7x'
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(opts?.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  const file =
    opts?.file === undefined ? { buffer: JPEG_BYTES, mimeType: 'image/jpeg' } : opts.file
  if (file) {
    const filename = file.filename ?? 'till-receipt.jpg'
    const typeHeader = file.mimeType === null ? '' : `Content-Type: ${file.mimeType}\r\n`
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${opts?.fieldName ?? 'file'}"; filename="${filename}"\r\n${typeHeader}\r\n`,
      ),
    )
    parts.push(file.buffer)
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

function uploadReceipt(opts?: Parameters<typeof multipartForm>[0], cookie = cookieA, job = () => jobId) {
  const form = multipartForm(opts)
  return app.inject({
    method: 'POST',
    url: `/api/jobs/${job()}/receipts`,
    headers: { cookie, 'content-type': form.contentType },
    payload: form.payload,
  })
}

function uploadPhoto(cookie = cookieA) {
  const form = multipartForm({ fieldName: 'photo' })
  return app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/photos`,
    headers: { cookie, 'content-type': form.contentType },
    payload: form.payload,
  })
}

function listReceipts(cookie = cookieA) {
  return app.inject({ method: 'GET', url: `/api/jobs/${jobId}/receipts`, headers: { cookie } })
}

function listPhotos(cookie = cookieA) {
  return app.inject({ method: 'GET', url: `/api/jobs/${jobId}/photos`, headers: { cookie } })
}

beforeAll(async () => {
  savedEnv = {
    SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
    PILOT_USER_ID: process.env.PILOT_USER_ID,
  }
  process.env.SESSION_COOKIE_SECRET = TEST_SECRET
  delete process.env.PILOT_USER_ID

  storage = new FakeAudioStorage()
  app = buildApp({
    storage,
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
    email: new DevEmailProvider(),
  })
  await app.ready()
  await cleanup()

  const userA = await signupCookie('user-a')
  userAId = userA.id
  cookieA = userA.cookie
  cookieB = (await signupCookie('user-b')).cookie
})

afterAll(async () => {
  await cleanup()
  await app.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// Each test gets a fresh job so lists and removal are independent.
beforeEach(async () => {
  storage.clear()
  const job = await prisma.job.create({
    data: { ownerUserId: userAId, title: 'Garden room', jobType: 'garden_room' },
  })
  jobId = job.id
})

describe('POST /api/jobs/:jobId/receipts', () => {
  it('uploads an image receipt with no descriptor and returns a safe JobReceipt shape', async () => {
    const res = await uploadReceipt()
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({
      jobId,
      kind: 'receipt',
      fileKind: 'image',
      descriptor: null,
      originalFileName: 'till-receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: JPEG_BYTES.byteLength,
    })
    expect(body.fileUrl).toBe(`/api/jobs/${jobId}/receipts/${body.id}/file`)
    // v1: images reuse the authenticated file route as their thumbnail.
    expect(body.thumbnailUrl).toBe(body.fileUrl)
    expect(body.uploadedAt).toBeTruthy()
    expect(body.createdAt).toBeTruthy()
    expect(body.updatedAt).toBeTruthy()
    // never leak storage internals
    expect(body).not.toHaveProperty('storageKey')
    expect(body).not.toHaveProperty('bucket')
    expect(body).not.toHaveProperty('uploadedByUserId')
  })

  it('uploads a PDF invoice with a descriptor and reports fileKind pdf with no thumbnail', async () => {
    const res = await uploadReceipt({
      fields: { descriptor: 'Jewson invoice' },
      file: { buffer: PDF_BYTES, mimeType: 'application/pdf', filename: 'invoice-9912.pdf' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      kind: 'receipt',
      fileKind: 'pdf',
      descriptor: 'Jewson invoice',
      originalFileName: 'invoice-9912.pdf',
      mimeType: 'application/pdf',
    })
    expect(res.json().thumbnailUrl).toBeNull()
  })

  it('stores the bytes under a generated job/receipt key, never the filename', async () => {
    const res = await uploadReceipt({ file: { buffer: JPEG_BYTES, mimeType: 'image/jpeg', filename: '../../etc/passwd.jpg' } })
    expect(res.statusCode).toBe(201)
    const keys = [...storage.stored.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(new RegExp(`^jobs/${jobId}/receipts/[0-9a-f-]+$`))
    // path components stripped from the stored display name
    expect(res.json().originalFileName).toBe('passwd.jpg')
  })

  it('trims the descriptor and stores blank as null', async () => {
    let res = await uploadReceipt({ fields: { descriptor: '  screws receipt  ' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().descriptor).toBe('screws receipt')

    res = await uploadReceipt({ fields: { descriptor: '   ' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().descriptor).toBeNull()
  })

  it('bounds a long original file name to 160 characters', async () => {
    const longName = `${'n'.repeat(200)}.jpg`
    const res = await uploadReceipt({ file: { buffer: JPEG_BYTES, mimeType: 'image/jpeg', filename: longName } })
    expect(res.statusCode).toBe(201)
    expect(res.json().originalFileName).toHaveLength(160)
  })

  it('rejects a descriptor over 120 characters', async () => {
    const res = await uploadReceipt({ fields: { descriptor: 'x'.repeat(121) } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('rejects a missing file with 400 MISSING_FIELD', async () => {
    const res = await uploadReceipt({ file: null, fields: { descriptor: 'no file' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('rejects an empty file with 400 MISSING_FIELD', async () => {
    const res = await uploadReceipt({ file: { buffer: Buffer.alloc(0), mimeType: 'image/jpeg' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MISSING_FIELD')
  })

  it('accepts every supported image type', async () => {
    for (const mimeType of ['image/png', 'image/webp', 'image/heic', 'image/heif']) {
      const res = await uploadReceipt({ file: { buffer: Buffer.from('opaque-image-bytes'), mimeType } })
      expect(res.statusCode, mimeType).toBe(201)
      expect(res.json()).toMatchObject({ mimeType, fileKind: 'image' })
    }
  })

  it('rejects an unsupported type with 415 RECEIPT_UNSUPPORTED_TYPE', async () => {
    const res = await uploadReceipt({
      file: { buffer: Buffer.from('word doc'), mimeType: 'application/msword', filename: 'quote.doc' },
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })

  it('rejects PDF bytes declared as an image (magic-byte mismatch)', async () => {
    const res = await uploadReceipt({ file: { buffer: PDF_BYTES, mimeType: 'image/jpeg' } })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })

  it('rejects image bytes declared as a PDF (magic-byte mismatch)', async () => {
    const res = await uploadReceipt({ file: { buffer: JPEG_BYTES, mimeType: 'application/pdf' } })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })

  it('rejects a file over the 20 MB limit with 413 RECEIPT_TOO_LARGE', async () => {
    const oversized = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(MAX_RECEIPT_BYTES, 0x41),
    ])
    const res = await uploadReceipt({ file: { buffer: oversized, mimeType: 'image/jpeg' } })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('RECEIPT_TOO_LARGE')
    // nothing persisted for a rejected upload
    expect(await prisma.jobPhoto.count({ where: { jobId } })).toBe(0)
  })

  it('requires authentication', async () => {
    const form = multipartForm()
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/receipts`,
      headers: { 'content-type': form.contentType },
      payload: form.payload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('404s an unknown job and 403s another user\'s job', async () => {
    const missing = await uploadReceipt(undefined, cookieA, () => '00000000-0000-0000-0000-000000000000')
    expect(missing.statusCode).toBe(404)
    expect(missing.json().code).toBe('JOB_NOT_FOUND')

    const forbidden = await uploadReceipt(undefined, cookieB)
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().code).toBe('FORBIDDEN')
  })
})

// iOS Safari / the Files provider often hands us a PDF with a generic or
// missing Content-Type. Magic bytes are the gate, and the stored type is
// normalised so the file still opens as a PDF later.
describe('POST /api/jobs/:jobId/receipts — phone PDF uploads', () => {
  it('accepts a .pdf filename sent as application/octet-stream with %PDF- bytes', async () => {
    const res = await uploadReceipt({
      file: { buffer: PDF_BYTES, mimeType: 'application/octet-stream', filename: 'invoice-9912.pdf' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      kind: 'receipt',
      fileKind: 'pdf',
      mimeType: 'application/pdf',
      originalFileName: 'invoice-9912.pdf',
    })
    expect(res.json().thumbnailUrl).toBeNull()
  })

  it('accepts a .pdf filename sent with no Content-Type at all', async () => {
    const res = await uploadReceipt({
      file: { buffer: PDF_BYTES, mimeType: null, filename: 'scan.pdf' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ fileKind: 'pdf', mimeType: 'application/pdf' })
  })

  it('accepts application/x-pdf with %PDF- bytes', async () => {
    const res = await uploadReceipt({
      file: { buffer: PDF_BYTES, mimeType: 'application/x-pdf', filename: 'receipt.pdf' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ fileKind: 'pdf', mimeType: 'application/pdf' })
  })

  it('rejects a .pdf filename sent as octet-stream when the bytes are not a PDF', async () => {
    const res = await uploadReceipt({
      file: { buffer: Buffer.from('this is not a pdf at all'), mimeType: 'application/octet-stream', filename: 'invoice.pdf' },
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
    expect(await prisma.jobPhoto.count({ where: { jobId } })).toBe(0)
  })

  it('rejects an arbitrary octet-stream upload', async () => {
    const res = await uploadReceipt({
      file: { buffer: Buffer.from('PKzip-ish'), mimeType: 'application/octet-stream', filename: 'stuff.zip' },
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })

  // Documented choice: magic bytes decide, not the extension, so a PDF saved
  // under any name still uploads. The original file name is preserved as
  // given (path-stripped and length-bounded), never rewritten to .pdf.
  it('accepts PDF bytes under a non-pdf filename and preserves that filename', async () => {
    const res = await uploadReceipt({
      file: { buffer: PDF_BYTES, mimeType: 'application/octet-stream', filename: '../scan 2026-08-06' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      fileKind: 'pdf',
      mimeType: 'application/pdf',
      originalFileName: 'scan 2026-08-06',
    })
  })

  it('serves a sniffed phone PDF back as application/pdf', async () => {
    const id = (
      await uploadReceipt({
        file: { buffer: PDF_BYTES, mimeType: 'application/octet-stream', filename: 'invoice.pdf' },
      })
    ).json().id
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${id}/file`,
      headers: { cookie: cookieA },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.rawPayload.equals(PDF_BYTES)).toBe(true)
  })

  it('still rejects a genuine text file', async () => {
    const res = await uploadReceipt({
      file: { buffer: Buffer.from('just some site notes'), mimeType: 'text/plain', filename: 'notes.txt' },
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })

  it('still rejects an image sent as octet-stream', async () => {
    // Image validation is unchanged: images must declare a supported image type.
    const res = await uploadReceipt({
      file: { buffer: JPEG_BYTES, mimeType: 'application/octet-stream', filename: 'photo.jpg' },
    })
    expect(res.statusCode).toBe(415)
    expect(res.json().code).toBe('RECEIPT_UNSUPPORTED_TYPE')
  })
})

describe('GET /api/jobs/:jobId/receipts', () => {
  it('returns receipt/invoice evidence newest first', async () => {
    const first = await uploadReceipt({ fields: { descriptor: 'older' } })
    const second = await uploadReceipt({
      fields: { descriptor: 'newer' },
      file: { buffer: PDF_BYTES, mimeType: 'application/pdf', filename: 'newer.pdf' },
    })
    // Make ordering unambiguous regardless of clock resolution.
    await prisma.jobPhoto.update({
      where: { id: first.json().id },
      data: { uploadedAt: new Date('2026-08-01T09:00:00.000Z') },
    })
    await prisma.jobPhoto.update({
      where: { id: second.json().id },
      data: { uploadedAt: new Date('2026-08-02T09:00:00.000Z') },
    })

    const res = await listReceipts()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.jobId).toBe(jobId)
    expect(body.receipts.map((r: { descriptor: string }) => r.descriptor)).toEqual(['newer', 'older'])
    expect(body.receipts.every((r: { kind: string }) => r.kind === 'receipt')).toBe(true)
  })

  it('returns an empty list for a job with no receipts', async () => {
    const res = await listReceipts()
    expect(res.statusCode).toBe(200)
    expect(res.json().receipts).toEqual([])
  })

  it('does not include job photos', async () => {
    expect((await uploadPhoto()).statusCode).toBe(201)
    const res = await listReceipts()
    expect(res.json().receipts).toEqual([])
  })

  it('requires authentication and blocks the other user', async () => {
    await uploadReceipt()
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/receipts` })).statusCode).toBe(401)
    const other = await listReceipts(cookieB)
    expect(other.statusCode).toBe(403)
    expect(other.json().code).toBe('FORBIDDEN')
  })
})

describe('Photos and Receipts stay separate', () => {
  it('keeps receipt images out of the Photos list and photos out of Receipts', async () => {
    const photo = await uploadPhoto()
    expect(photo.statusCode).toBe(201)
    const imageReceipt = await uploadReceipt()
    expect(imageReceipt.statusCode).toBe(201)
    const pdfReceipt = await uploadReceipt({
      file: { buffer: PDF_BYTES, mimeType: 'application/pdf', filename: 'inv.pdf' },
    })
    expect(pdfReceipt.statusCode).toBe(201)

    const photos = (await listPhotos()).json().photos
    expect(photos.map((p: { id: string }) => p.id)).toEqual([photo.json().id])

    const receipts = (await listReceipts()).json().receipts
    expect(receipts.map((r: { id: string }) => r.id).sort()).toEqual(
      [imageReceipt.json().id, pdfReceipt.json().id].sort(),
    )
  })

  it('does not expose a receipt through the photo routes', async () => {
    const receiptId = (await uploadReceipt()).json().id
    const file = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/photos/${receiptId}/file`,
      headers: { cookie: cookieA },
    })
    expect(file.statusCode).toBe(404)
    expect(file.json().code).toBe('PHOTO_NOT_FOUND')

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/photos/${receiptId}`,
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      payload: { descriptor: 'reclassified' },
    })
    expect(patch.statusCode).toBe(404)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}/photos/${receiptId}`,
      headers: { cookie: cookieA },
    })
    expect(del.statusCode).toBe(404)
  })

  it('does not expose a photo through the receipt routes', async () => {
    const photoId = (await uploadPhoto()).json().id
    const file = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${photoId}/file`,
      headers: { cookie: cookieA },
    })
    expect(file.statusCode).toBe(404)
    expect(file.json().code).toBe('RECEIPT_NOT_FOUND')
  })

  it('classifies existing photo rows with no explicit kind as photos', async () => {
    // Simulates a pre-migration row: kind/fileKind fall back to their defaults.
    const legacy = await prisma.$executeRawUnsafe(
      `INSERT INTO job_photos (id, "jobId", "uploadedByUserId", "storageKey", bucket, "mimeType", "sizeBytes", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 'fake', 'image/jpeg', 3, now())`,
      jobId,
      userAId,
      `jobs/${jobId}/photos/legacy-${jobId}`,
    )
    expect(legacy).toBe(1)

    const row = await prisma.jobPhoto.findFirst({ where: { jobId } })
    expect(row?.kind).toBe('PHOTO')
    expect(row?.fileKind).toBe('IMAGE')
    expect((await listPhotos()).json().photos).toHaveLength(1)
    expect((await listReceipts()).json().receipts).toEqual([])
  })
})

describe('GET /api/jobs/:jobId/receipts/:receiptId/file', () => {
  it('returns the image bytes and MIME type', async () => {
    const id = (await uploadReceipt()).json().id
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${id}/file`,
      headers: { cookie: cookieA },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.rawPayload.equals(JPEG_BYTES)).toBe(true)
    expect(res.headers['content-disposition']).toContain('inline')
    expect(res.headers['content-disposition']).toContain('till-receipt.jpg')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
  })

  it('returns the PDF bytes openable inline', async () => {
    const id = (
      await uploadReceipt({
        file: { buffer: PDF_BYTES, mimeType: 'application/pdf', filename: 'invoice-9912.pdf' },
      })
    ).json().id
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${id}/file`,
      headers: { cookie: cookieA },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.rawPayload.equals(PDF_BYTES)).toBe(true)
    expect(res.headers['content-disposition']).toContain('inline')
  })

  it('404s an unknown receipt without leaking storage detail', async () => {
    await uploadReceipt()
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/00000000-0000-0000-0000-000000000000/file`,
      headers: { cookie: cookieA },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ code: 'RECEIPT_NOT_FOUND', message: 'Receipt not found' })
  })

  it('blocks unauthenticated and cross-user file access', async () => {
    const id = (await uploadReceipt()).json().id
    const anon = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/receipts/${id}/file` })
    expect(anon.statusCode).toBe(401)

    const other = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${id}/file`,
      headers: { cookie: cookieB },
    })
    expect(other.statusCode).toBe(403)
  })
})

describe('PATCH /api/jobs/:jobId/receipts/:receiptId', () => {
  function patch(id: string, body: object, cookie = cookieA) {
    return app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/receipts/${id}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: body,
    })
  }

  it('sets, trims, preserves, and clears the descriptor', async () => {
    const id = (await uploadReceipt({ fields: { descriptor: 'Travis Perkins' } })).json().id

    let res = await patch(id, { descriptor: '  Wickes timber  ' })
    expect(res.statusCode).toBe(200)
    expect(res.json().descriptor).toBe('Wickes timber')

    // omitted preserves
    res = await patch(id, {})
    expect(res.json().descriptor).toBe('Wickes timber')

    // null clears
    res = await patch(id, { descriptor: null })
    expect(res.json().descriptor).toBeNull()

    // blank clears
    await patch(id, { descriptor: 'again' })
    res = await patch(id, { descriptor: '   ' })
    expect(res.json().descriptor).toBeNull()
  })

  it('rejects a descriptor over 120 characters', async () => {
    const id = (await uploadReceipt()).json().id
    const res = await patch(id, { descriptor: 'y'.repeat(121) })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it('blocks cross-user patching', async () => {
    const id = (await uploadReceipt()).json().id
    const res = await patch(id, { descriptor: 'hijacked' }, cookieB)
    expect(res.statusCode).toBe(403)
    expect((await listReceipts()).json().receipts[0].descriptor).toBeNull()
  })
})

describe('DELETE /api/jobs/:jobId/receipts/:receiptId', () => {
  function remove(id: string, cookie = cookieA) {
    return app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}/receipts/${id}`,
      headers: { cookie },
    })
  }

  it('soft-removes the receipt from the list but keeps the stored object', async () => {
    const keep = (await uploadReceipt({ fields: { descriptor: 'keep' } })).json()
    const drop = (await uploadReceipt({ fields: { descriptor: 'drop' } })).json()

    const res = await remove(drop.id)
    expect(res.statusCode).toBe(204)

    const receipts = (await listReceipts()).json().receipts
    expect(receipts.map((r: { id: string }) => r.id)).toEqual([keep.id])

    // metadata row and object both survive
    const row = await prisma.jobPhoto.findUnique({ where: { id: drop.id } })
    expect(row).toMatchObject({ isDeleted: true, kind: 'RECEIPT' })
    expect(row?.deletedAt).toBeTruthy()
    expect(storage.stored.has(row!.storageKey)).toBe(true)
  })

  it('404s the file route and a repeat delete after removal', async () => {
    const id = (await uploadReceipt()).json().id
    expect((await remove(id)).statusCode).toBe(204)

    const file = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/receipts/${id}/file`,
      headers: { cookie: cookieA },
    })
    expect(file.statusCode).toBe(404)
    expect((await remove(id)).statusCode).toBe(404)
    expect((await remove(id)).json().code).toBe('RECEIPT_NOT_FOUND')
  })

  it('blocks cross-user deletion', async () => {
    const id = (await uploadReceipt()).json().id
    const res = await remove(id, cookieB)
    expect(res.statusCode).toBe(403)
    expect((await listReceipts()).json().receipts).toHaveLength(1)
  })

  it('leaves job photos untouched', async () => {
    const photoId = (await uploadPhoto()).json().id
    const receiptId = (await uploadReceipt()).json().id
    expect((await remove(receiptId)).statusCode).toBe(204)
    expect((await listPhotos()).json().photos.map((p: { id: string }) => p.id)).toEqual([photoId])
  })
})

describe('receipts have no Budget, Money, or Memory side effects', () => {
  // Read models stamp their own generatedAt; strip it so the comparison is
  // about the data, not the clock.
  function stripGeneratedAt<T>(value: T): T {
    if (Array.isArray(value)) return value.map(stripGeneratedAt) as unknown as T
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'generatedAt')
          .map(([k, v]) => [k, stripGeneratedAt(v)]),
      ) as T
    }
    return value
  }

  async function readState() {
    const get = async (path: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}${path}`, headers: { cookie: cookieA } })
      expect(res.statusCode).toBe(200)
      return stripGeneratedAt(res.json())
    }
    const [budgetSummary, categories, money, memoryView] = await Promise.all([
      get('/budget-summary'),
      get('/budget-categories'),
      get('/money'),
      get('/memory-view'),
    ])
    const [candidateFacts, memoryItems, reviewDecisions, moneyEvents] = await Promise.all([
      prisma.candidateFact.count({ where: { jobId } }),
      prisma.memoryItem.count({ where: { jobId } }),
      prisma.reviewDecision.count({ where: { jobId } }),
      prisma.jobMoneyEvent.count({ where: { jobId } }),
    ])
    return {
      budgetSummary,
      categories,
      money,
      memoryView,
      counts: { candidateFacts, memoryItems, reviewDecisions, moneyEvents },
    }
  }

  it('upload, patch, and remove leave Budget/Money/memory-view identical', async () => {
    // memory-view builds a fresh queue on read, so prime it before snapshotting.
    await readState()
    const before = await readState()

    const id = (await uploadReceipt({ fields: { descriptor: 'Screwfix' } })).json().id
    const pdfId = (
      await uploadReceipt({ file: { buffer: PDF_BYTES, mimeType: 'application/pdf', filename: 'inv.pdf' } })
    ).json().id
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/jobs/${jobId}/receipts/${id}`,
          headers: { cookie: cookieA, 'content-type': 'application/json' },
          payload: { descriptor: 'Screwfix nails' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}/receipts/${pdfId}`, headers: { cookie: cookieA } }))
        .statusCode,
    ).toBe(204)

    const after = await readState()
    expect(after).toEqual(before)

    // no notes/transcripts created either — nothing was queued for processing
    expect(await prisma.rawNote.count({ where: { jobId } })).toBe(0)
    expect(await prisma.queueItem.count({ where: { jobId } })).toBe(0)
  })
})
