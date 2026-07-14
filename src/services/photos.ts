import { randomUUID } from 'crypto'
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'

// 15 MB per photo (below the 25 MB global multipart limit, so photo size is
// enforced here with the photo-specific error code).
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024

export const MAX_PHOTO_DESCRIPTOR_LENGTH = 120

// Common browser/phone image uploads, including iPhone HEIC/HEIF.
const ACCEPTED_PHOTO_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

export function isSupportedPhotoMimeType(mimeType: string): boolean {
  return ACCEPTED_PHOTO_MIME_TYPES.has(mimeType.toLowerCase().split(';')[0].trim())
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
  if (trimmed.length > MAX_PHOTO_DESCRIPTOR_LENGTH) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: `descriptor must be at most ${MAX_PHOTO_DESCRIPTOR_LENGTH} characters`,
    }
  }
  return trimmed
}

// A photo has at most one link target: unlinked, a raw note, or a memory item.
function assertSingleLinkTarget(linkedNoteId: string | null, linkedMemoryItemId: string | null) {
  if (linkedNoteId && linkedMemoryItemId) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: 'A photo may link to a note or a memory item, not both',
    }
  }
}

// Link targets must live in the same job; anything else is not found (no
// existence leak across jobs/users).
async function assertLinkTargetsInJob(
  jobId: string,
  linkedNoteId: string | null,
  linkedMemoryItemId: string | null,
) {
  if (linkedNoteId) {
    const note = await prisma.rawNote.findFirst({ where: { id: linkedNoteId, jobId } })
    if (!note) throw { code: ErrorCode.PHOTO_LINK_TARGET_NOT_FOUND, message: 'Linked note not found in this job' }
  }
  if (linkedMemoryItemId) {
    const item = await prisma.memoryItem.findFirst({ where: { id: linkedMemoryItemId, jobId } })
    if (!item) throw { code: ErrorCode.PHOTO_LINK_TARGET_NOT_FOUND, message: 'Linked memory item not found in this job' }
  }
}

const LINKED_INCLUDE = {
  linkedNote: { select: { id: true, capturedAt: true } },
  linkedMemoryItem: { select: { id: true, memoryType: true, summary: true } },
} as const

// The wire shape: no storage key, bucket, uploader id, or signed URL — bytes
// are only reachable through the authenticated file route.
function normalizeJobPhoto(photo: {
  id: string
  jobId: string
  descriptor: string | null
  mimeType: string
  sizeBytes: number
  uploadedAt: Date
  createdAt: Date
  updatedAt: Date
  linkedNoteId: string | null
  linkedMemoryItemId: string | null
  linkedNote: { id: string; capturedAt: Date } | null
  linkedMemoryItem: { id: string; memoryType: string; summary: string } | null
}) {
  return {
    id: photo.id,
    jobId: photo.jobId,
    descriptor: photo.descriptor,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    uploadedAt: photo.uploadedAt,
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt,
    linkedNoteId: photo.linkedNoteId,
    linkedMemoryItemId: photo.linkedMemoryItemId,
    linkedNote: photo.linkedNote,
    linkedMemoryItem: photo.linkedMemoryItem
      ? { ...photo.linkedMemoryItem, memoryType: photo.linkedMemoryItem.memoryType.toLowerCase() }
      : null,
    imageUrl: `/api/jobs/${photo.jobId}/photos/${photo.id}/file`,
  }
}

export interface CreateJobPhotoInput {
  jobId: string
  userId: string
  photoBuffer: Buffer
  mimeType: string
  descriptor?: string | null
  linkedNoteId?: string | null
  linkedMemoryItemId?: string | null
}

// Upload is context storage only: no candidate facts, memory items, review
// decisions, spend changes, or extraction are ever triggered from here.
export async function createJobPhoto(input: CreateJobPhotoInput, storage: AudioStorageProvider) {
  await verifyJobOwnership(input.jobId, input.userId)

  if (!isSupportedPhotoMimeType(input.mimeType)) {
    throw { code: ErrorCode.PHOTO_UNSUPPORTED_TYPE, message: `Unsupported photo type: ${input.mimeType}` }
  }
  if (input.photoBuffer.byteLength > MAX_PHOTO_BYTES) {
    throw { code: ErrorCode.PHOTO_TOO_LARGE, message: 'Photo exceeds max size' }
  }

  const descriptor = normalizeDescriptor(input.descriptor)
  const linkedNoteId = input.linkedNoteId ?? null
  const linkedMemoryItemId = input.linkedMemoryItemId ?? null
  assertSingleLinkTarget(linkedNoteId, linkedMemoryItemId)
  await assertLinkTargetsInJob(input.jobId, linkedNoteId, linkedMemoryItemId)

  // Key is generated, never derived from the user-supplied filename.
  const photoId = randomUUID()
  const storageKey = `jobs/${input.jobId}/photos/${photoId}`

  const stored = await storage.store(storageKey, input.photoBuffer, input.mimeType)

  try {
    const created = await prisma.jobPhoto.create({
      data: {
        id: photoId,
        jobId: input.jobId,
        uploadedByUserId: input.userId,
        descriptor,
        storageKey: stored.key,
        bucket: stored.bucket,
        mimeType: input.mimeType,
        sizeBytes: input.photoBuffer.byteLength,
        linkedNoteId,
        linkedMemoryItemId,
      },
      include: LINKED_INCLUDE,
    })
    return normalizeJobPhoto(created)
  } catch (err) {
    // Storage happened before the DB commit: best-effort object cleanup so a
    // failed upload leaves nothing orphaned.
    await storage.delete(stored.key).catch(() => {})
    throw err
  }
}

export async function listJobPhotos(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const photos = await prisma.jobPhoto.findMany({
    where: { jobId, isDeleted: false },
    include: LINKED_INCLUDE,
    orderBy: [{ uploadedAt: 'desc' }, { createdAt: 'desc' }],
  })
  return { jobId, photos: photos.map(normalizeJobPhoto) }
}

export async function getJobPhotoFile(
  jobId: string,
  photoId: string,
  userId: string,
  storage: AudioStorageProvider,
) {
  await verifyJobOwnership(jobId, userId)
  const photo = await prisma.jobPhoto.findFirst({ where: { id: photoId, jobId, isDeleted: false } })
  if (!photo) throw { code: ErrorCode.PHOTO_NOT_FOUND, message: 'Photo not found' }

  let bytes: Buffer
  try {
    bytes = await storage.read(photo.storageKey)
  } catch {
    // Missing/unreadable object: safe not-found, never leaking storage details.
    throw { code: ErrorCode.PHOTO_NOT_FOUND, message: 'Photo not found' }
  }
  return { bytes, mimeType: photo.mimeType }
}

export interface PatchJobPhotoInput {
  descriptor?: string | null
  linkedNoteId?: string | null
  linkedMemoryItemId?: string | null
}

// Omitted fields preserve existing values; explicit null clears. The merged
// result must still have at most one link target, in the same job.
export async function patchJobPhoto(
  jobId: string,
  photoId: string,
  userId: string,
  patch: PatchJobPhotoInput,
) {
  await verifyJobOwnership(jobId, userId)
  const existing = await prisma.jobPhoto.findFirst({ where: { id: photoId, jobId, isDeleted: false } })
  if (!existing) throw { code: ErrorCode.PHOTO_NOT_FOUND, message: 'Photo not found' }

  const descriptor =
    'descriptor' in patch ? normalizeDescriptor(patch.descriptor) : existing.descriptor
  const linkedNoteId =
    'linkedNoteId' in patch ? (patch.linkedNoteId ?? null) : existing.linkedNoteId
  const linkedMemoryItemId =
    'linkedMemoryItemId' in patch ? (patch.linkedMemoryItemId ?? null) : existing.linkedMemoryItemId

  assertSingleLinkTarget(linkedNoteId, linkedMemoryItemId)

  // Only validate targets that are being newly set; preserved links were
  // validated when they were written.
  await assertLinkTargetsInJob(
    jobId,
    'linkedNoteId' in patch ? linkedNoteId : null,
    'linkedMemoryItemId' in patch ? linkedMemoryItemId : null,
  )

  const updated = await prisma.jobPhoto.update({
    where: { id: photoId },
    data: { descriptor, linkedNoteId, linkedMemoryItemId },
    include: LINKED_INCLUDE,
  })
  return normalizeJobPhoto(updated)
}

// Soft delete: the photo disappears from list/file reads but the metadata row
// and the stored object remain (no physical R2/local deletion in this slice).
// Deleting an already-deleted photo is 404.
export async function deleteJobPhoto(jobId: string, photoId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const existing = await prisma.jobPhoto.findFirst({ where: { id: photoId, jobId, isDeleted: false } })
  if (!existing) throw { code: ErrorCode.PHOTO_NOT_FOUND, message: 'Photo not found' }

  await prisma.jobPhoto.update({
    where: { id: photoId },
    data: { isDeleted: true, deletedAt: new Date(), deletedByUserId: userId },
  })
}
