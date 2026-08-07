import { randomUUID } from 'crypto'
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'

// 20 MB per receipt/invoice file, per the receipts spec. This sits below the
// 25 MB global multipart limit, so the receipt-specific code is what callers
// normally see; the app error handler maps the global limit for /receipts too.
export const MAX_RECEIPT_BYTES = 20 * 1024 * 1024

export const MAX_RECEIPT_DESCRIPTOR_LENGTH = 120
export const MAX_ORIGINAL_FILE_NAME_LENGTH = 160

// Paper receipts photographed on a phone, screenshots, downloaded receipt
// images, and existing PDF receipts/invoices.
const ACCEPTED_RECEIPT_MIME_TYPES = new Map<string, 'IMAGE' | 'PDF'>([
  ['image/jpeg', 'IMAGE'],
  ['image/png', 'IMAGE'],
  ['image/webp', 'IMAGE'],
  ['image/heic', 'IMAGE'],
  ['image/heif', 'IMAGE'],
  ['application/pdf', 'PDF'],
])

// Phone PDF uploads (iOS Safari / the Files provider) frequently arrive with a
// generic or missing type instead of application/pdf. These declared types are
// treated as "unknown, might be a PDF" and are accepted only when the bytes
// actually start with %PDF-.
// `text/plain` is in here because busboy substitutes it when a multipart part
// carries no Content-Type at all, which is one of the shapes phone uploads
// take; it is not a claim that text files are receipts. Nothing in this set is
// accepted on the strength of its declared type — only on %PDF- bytes.
const UNKNOWN_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-pdf',
  'text/plain',
])

function baseMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').toLowerCase().split(';')[0].trim()
}

export function receiptFileKind(mimeType: string): 'IMAGE' | 'PDF' | null {
  return ACCEPTED_RECEIPT_MIME_TYPES.get(baseMimeType(mimeType)) ?? null
}

// Basic magic-byte family detection. Deliberately conservative: we only use it
// to reject a declared type that contradicts a *recognised* signature (e.g. a
// PDF uploaded as image/jpeg). Unrecognised bytes are allowed through so we
// don't reject genuine but unusual phone image encodings.
function detectFileFamily(buffer: Buffer): 'PDF' | 'IMAGE' | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'IMAGE' // jpeg
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'IMAGE'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'IMAGE'
  }
  // ISO base media (HEIC/HEIF): "ftyp" box brand at offset 4.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'IMAGE'
  return null
}

// Decide what a receipt upload actually is, and normalise the type we store.
//
// Images are unchanged: the declared type must be one we accept, and it must
// not contradict a recognised signature.
//
// PDFs are tolerant of the phone path. A declared application/pdf is accepted
// as before; a generic or missing type (octet-stream, application/x-pdf, no
// type at all) is accepted only if the bytes start with %PDF-, and is then
// stored as application/pdf / PDF. Magic bytes — not the file extension — are
// the gate, so a PDF saved without a .pdf name still uploads; the original
// file name is preserved as given (safely normalised) rather than rewritten.
// An octet-stream upload whose bytes are not a PDF is always rejected.
export function resolveReceiptFileType(
  declaredMimeType: string | null | undefined,
  fileBuffer: Buffer,
): { mimeType: string; fileKind: 'IMAGE' | 'PDF' } {
  const base = baseMimeType(declaredMimeType)
  const detected = detectFileFamily(fileBuffer)
  const declaredKind = ACCEPTED_RECEIPT_MIME_TYPES.get(base)

  if (declaredKind) {
    if (detected && detected !== declaredKind) {
      throw {
        code: ErrorCode.RECEIPT_UNSUPPORTED_TYPE,
        message: `File contents do not match the declared type: ${base}`,
      }
    }
    return { mimeType: base, fileKind: declaredKind }
  }

  if (UNKNOWN_MIME_TYPES.has(base)) {
    if (detected === 'PDF') return { mimeType: 'application/pdf', fileKind: 'PDF' }
    throw {
      code: ErrorCode.RECEIPT_UNSUPPORTED_TYPE,
      message: 'Unsupported receipt file: expected an image or a PDF',
    }
  }

  throw {
    code: ErrorCode.RECEIPT_UNSUPPORTED_TYPE,
    message: `Unsupported receipt type: ${base}`,
  }
}

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
}

// Trim the descriptor, mapping blank to null; enforce the v1 length cap.
function normalizeDescriptor(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > MAX_RECEIPT_DESCRIPTOR_LENGTH) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: `descriptor must be at most ${MAX_RECEIPT_DESCRIPTOR_LENGTH} characters`,
    }
  }
  return trimmed
}

// Stored for recognition only — never used as (or as part of) the storage key.
// Path components are stripped and the length is bounded; an unusable name
// becomes null rather than an error, since browsers may omit it.
export function normalizeOriginalFileName(value: string | null | undefined): string | null {
  if (value == null) return null
  const withoutPath = value.split(/[\\/]/).pop() ?? ''
  // Drop control characters that would be unsafe in a Content-Disposition header.
  const cleaned = withoutPath.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (cleaned === '') return null
  return cleaned.slice(0, MAX_ORIGINAL_FILE_NAME_LENGTH)
}

interface JobReceiptRow {
  id: string
  jobId: string
  fileKind: string
  descriptor: string | null
  originalFileName: string | null
  mimeType: string
  sizeBytes: number
  uploadedAt: Date
  createdAt: Date
  updatedAt: Date
}

// The wire shape: no storage key, bucket, uploader id, or signed URL — bytes
// are only reachable through the authenticated file route. PDFs have no
// thumbnail in v1; images reuse the same authenticated file route.
function normalizeJobReceipt(receipt: JobReceiptRow) {
  const fileKind = receipt.fileKind.toLowerCase() as 'image' | 'pdf'
  const fileUrl = `/api/jobs/${receipt.jobId}/receipts/${receipt.id}/file`
  return {
    id: receipt.id,
    jobId: receipt.jobId,
    kind: 'receipt' as const,
    fileKind,
    descriptor: receipt.descriptor,
    originalFileName: receipt.originalFileName,
    mimeType: receipt.mimeType,
    sizeBytes: receipt.sizeBytes,
    uploadedAt: receipt.uploadedAt,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    fileUrl,
    thumbnailUrl: fileKind === 'image' ? fileUrl : null,
  }
}

export interface CreateJobReceiptInput {
  jobId: string
  userId: string
  fileBuffer: Buffer
  mimeType: string
  descriptor?: string | null
  originalFileName?: string | null
}

// Upload is evidence storage only: no candidate facts, memory items, review
// queue items, review decisions, Budget/Money changes, OCR, or extraction are
// ever triggered from here.
export async function createJobReceipt(input: CreateJobReceiptInput, storage: AudioStorageProvider) {
  await verifyJobOwnership(input.jobId, input.userId)

  // Size first: a huge file should not be sniffed or stored.
  if (input.fileBuffer.byteLength > MAX_RECEIPT_BYTES) {
    throw { code: ErrorCode.RECEIPT_TOO_LARGE, message: 'Receipt exceeds max size' }
  }

  const { mimeType, fileKind } = resolveReceiptFileType(input.mimeType, input.fileBuffer)

  const descriptor = normalizeDescriptor(input.descriptor)
  const originalFileName = normalizeOriginalFileName(input.originalFileName)

  // Key is generated, never derived from the user-supplied filename.
  const receiptId = randomUUID()
  const storageKey = `jobs/${input.jobId}/receipts/${receiptId}`

  const stored = await storage.store(storageKey, input.fileBuffer, mimeType)

  try {
    const created = await prisma.jobPhoto.create({
      data: {
        id: receiptId,
        jobId: input.jobId,
        uploadedByUserId: input.userId,
        kind: 'RECEIPT',
        fileKind,
        descriptor,
        originalFileName,
        storageKey: stored.key,
        bucket: stored.bucket,
        // Normalised, not as declared: a phone PDF sniffed out of
        // octet-stream is stored and served as application/pdf.
        mimeType,
        sizeBytes: input.fileBuffer.byteLength,
      },
    })
    return normalizeJobReceipt(created)
  } catch (err) {
    // Storage happened before the DB commit: best-effort object cleanup so a
    // failed upload leaves nothing orphaned.
    await storage.delete(stored.key).catch(() => {})
    throw err
  }
}

export async function listJobReceipts(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const receipts = await prisma.jobPhoto.findMany({
    where: { jobId, kind: 'RECEIPT', isDeleted: false },
    orderBy: [{ uploadedAt: 'desc' }, { createdAt: 'desc' }],
  })
  return { jobId, receipts: receipts.map(normalizeJobReceipt) }
}

export async function getJobReceiptFile(
  jobId: string,
  receiptId: string,
  userId: string,
  storage: AudioStorageProvider,
) {
  await verifyJobOwnership(jobId, userId)
  const receipt = await prisma.jobPhoto.findFirst({
    where: { id: receiptId, jobId, kind: 'RECEIPT', isDeleted: false },
  })
  if (!receipt) throw { code: ErrorCode.RECEIPT_NOT_FOUND, message: 'Receipt not found' }

  let bytes: Buffer
  try {
    bytes = await storage.read(receipt.storageKey)
  } catch {
    // Missing/unreadable object: safe not-found, never leaking storage details.
    throw { code: ErrorCode.RECEIPT_NOT_FOUND, message: 'Receipt not found' }
  }
  return { bytes, mimeType: receipt.mimeType, originalFileName: receipt.originalFileName }
}

export interface PatchJobReceiptInput {
  descriptor?: string | null
}

// Omitted preserves the existing descriptor; explicit null or blank clears it.
// No supplier, amount, purchase-date, or spend-link fields in this slice.
export async function patchJobReceipt(
  jobId: string,
  receiptId: string,
  userId: string,
  patch: PatchJobReceiptInput,
) {
  await verifyJobOwnership(jobId, userId)
  const existing = await prisma.jobPhoto.findFirst({
    where: { id: receiptId, jobId, kind: 'RECEIPT', isDeleted: false },
  })
  if (!existing) throw { code: ErrorCode.RECEIPT_NOT_FOUND, message: 'Receipt not found' }

  const descriptor =
    'descriptor' in patch ? normalizeDescriptor(patch.descriptor) : existing.descriptor

  const updated = await prisma.jobPhoto.update({
    where: { id: receiptId },
    data: { descriptor },
  })
  return normalizeJobReceipt(updated)
}

// Soft delete, matching the photo removal convention: the receipt disappears
// from list/file reads but the metadata row and the stored object remain (no
// physical R2/local deletion in this slice). Budget, Money, Memory, source
// notes, and photos are untouched. Deleting an already-removed receipt is 404.
export async function deleteJobReceipt(jobId: string, receiptId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const existing = await prisma.jobPhoto.findFirst({
    where: { id: receiptId, jobId, kind: 'RECEIPT', isDeleted: false },
  })
  if (!existing) throw { code: ErrorCode.RECEIPT_NOT_FOUND, message: 'Receipt not found' }

  await prisma.jobPhoto.update({
    where: { id: receiptId },
    data: { isDeleted: true, deletedAt: new Date(), deletedByUserId: userId },
  })
}
