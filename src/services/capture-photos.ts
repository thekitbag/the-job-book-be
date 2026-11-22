import { randomUUID } from 'node:crypto'
import type { CaptureContext, JobPhoto, Prisma } from '@prisma/client'
import { prisma } from '../db/client.js'
import type { AudioStorageProvider } from '../storage/index.js'
import { MAX_PHOTO_BYTES, isSupportedPhotoMimeType } from './photos.js'
import { captureError, requireFileableJob } from './capture-ownership.js'
import { isUniqueConstraintViolation } from './notes.js'

export const capturePhoto = (photo: JobPhoto) => ({
  id: photo.id,
  clientPhotoId: photo.clientPhotoId,
  jobId: photo.jobId,
  filedAt: photo.filedAt,
  captureContext: photo.captureContext.toLowerCase(),
  uploadedAt: photo.uploadedAt,
  fileUrl: `/api/photos/${photo.id}/file`,
})

export async function placePhoto(
  photoId: string,
  userId: string,
  jobId: string,
  move: boolean,
  fromRetry = false,
) {
  return prisma.$transaction(async (tx) => {
    const [photo] = await tx.$queryRaw<JobPhoto[]>`
      SELECT * FROM "job_photos" WHERE id = ${photoId} AND "uploadedByUserId" = ${userId}
        AND kind = 'PHOTO' AND NOT "isDeleted" FOR UPDATE
    `
    if (!photo) throw captureError('PHOTO_NOT_FOUND', 'Photo not found')
    await requireFileableJob(tx, jobId, userId)
    if (photo.jobId === jobId || (fromRetry && photo.jobId)) return photo
    if (!move && photo.jobId)
      throw captureError(
        'PHOTO_ALREADY_FILED',
        'This photo is already filed. Use move to change the job.',
      )
    if (move && !photo.jobId)
      throw captureError('PHOTO_NOT_FILED', 'File this photo before moving it')
    const updated = await tx.jobPhoto.update({
      where: { id: photoId },
      data: {
        jobId,
        ...(photo.jobId
          ? { linkedNoteId: null, linkedMemoryItemId: null }
          : { filedAt: new Date() }),
      },
    })
    if (photo.jobId)
      await tx.itemMove.create({
        data: {
          ownerUserId: userId,
          kind: 'PHOTO',
          photoId,
          fromJobId: photo.jobId,
          toJobId: jobId,
        },
      })
    return updated
  })
}

export async function uploadCapturePhoto(
  input: {
    userId: string
    jobId: string | null
    clientPhotoId: string
    captureContext: CaptureContext
    mimeType: string
    bytes: Buffer
  },
  storage: AudioStorageProvider,
) {
  const { userId, jobId, clientPhotoId, captureContext, mimeType, bytes } =
    input
  if (!isSupportedPhotoMimeType(mimeType))
    throw captureError('PHOTO_UNSUPPORTED_TYPE', 'Unsupported photo type')
  if (bytes.length > MAX_PHOTO_BYTES)
    throw captureError('PHOTO_TOO_LARGE', 'Photo exceeds max size')
  if (jobId) await requireFileableJob(prisma, jobId, userId)

  const where = {
    uploadedByUserId_clientPhotoId: { uploadedByUserId: userId, clientPhotoId },
  }
  const duplicate = async (photo: JobPhoto) => {
    if (photo.isDeleted)
      throw captureError('PHOTO_NOT_FOUND', 'Photo not found')
    return {
      photo:
        jobId && !photo.jobId
          ? await placePhoto(photo.id, userId, jobId, false, true)
          : photo,
      duplicate: true,
    }
  }
  const existing = await prisma.jobPhoto.findUnique({ where })
  if (existing) return duplicate(existing)
  const id = randomUUID()
  const stored = await storage.store(`photos/${userId}/${id}`, bytes, mimeType)
  try {
    const data: Prisma.JobPhotoUncheckedCreateInput = {
      id,
      jobId,
      clientPhotoId,
      captureContext,
      uploadedByUserId: userId,
      filedAt: jobId ? new Date() : null,
      mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.key,
      bucket: stored.bucket,
    }
    return { photo: await prisma.jobPhoto.create({ data }), duplicate: false }
  } catch (err) {
    await storage.delete(stored.key).catch(() => {})
    if (isUniqueConstraintViolation(err)) {
      const winner = await prisma.jobPhoto.findUnique({ where })
      if (winner) return duplicate(winner)
    }
    throw err
  }
}

export async function getCapturePhotoFile(
  photoId: string,
  userId: string,
  storage: AudioStorageProvider,
) {
  const photo = await prisma.jobPhoto.findFirst({
    where: {
      id: photoId,
      uploadedByUserId: userId,
      kind: 'PHOTO',
      isDeleted: false,
    },
  })
  if (photo) {
    try {
      return {
        bytes: await storage.read(photo.storageKey),
        mimeType: photo.mimeType,
      }
    } catch {
      /* Treat a missing object as a missing photo. */
    }
  }
  throw captureError('PHOTO_NOT_FOUND', 'Photo not found')
}
