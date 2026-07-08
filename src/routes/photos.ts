import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'
import { createJobPhoto, listJobPhotos, getJobPhotoFile, patchJobPhoto } from '../services/photos.js'
import { handleServiceError } from './jobs.js'

interface PhotosRouteOptions {
  storage: AudioStorageProvider
}

const photosRoutes: FastifyPluginAsync<PhotosRouteOptions> = async (fastify, opts) => {
  const { storage } = opts

  // POST /api/jobs/:jobId/photos — multipart photo upload (context only)
  fastify.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/photos',
    async (request, reply) => {
      const { jobId } = request.params
      try {
        const parts = request.parts()

        let descriptor: string | undefined
        let linkedNoteId: string | undefined
        let linkedMemoryItemId: string | undefined
        let mimeType: string | undefined
        let photoBuffer: Buffer | undefined

        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'descriptor') descriptor = part.value as string
            else if (part.fieldname === 'linkedNoteId') linkedNoteId = part.value as string
            else if (part.fieldname === 'linkedMemoryItemId') linkedMemoryItemId = part.value as string
          } else if (part.type === 'file' && part.fieldname === 'photo') {
            const chunks: Buffer[] = []
            for await (const chunk of part.file) chunks.push(chunk)
            photoBuffer = Buffer.concat(chunks)
            mimeType = part.mimetype
          }
        }

        if (!photoBuffer || photoBuffer.byteLength === 0 || !mimeType) {
          return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'photo file is required' })
        }

        const result = await createJobPhoto(
          {
            jobId,
            userId: request.userId,
            photoBuffer,
            mimeType,
            descriptor: descriptor ?? null,
            linkedNoteId: linkedNoteId || null,
            linkedMemoryItemId: linkedMemoryItemId || null,
          },
          storage,
        )
        return reply.code(201).send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // GET /api/jobs/:jobId/photos — newest first
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/photos',
    async (request, reply) => {
      try {
        const result = await listJobPhotos(request.params.jobId, request.userId)
        return reply.send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // GET /api/jobs/:jobId/photos/:photoId/file — authenticated image bytes
  fastify.get<{ Params: { jobId: string; photoId: string } }>(
    '/api/jobs/:jobId/photos/:photoId/file',
    async (request, reply) => {
      try {
        const { jobId, photoId } = request.params
        const { bytes, mimeType } = await getJobPhotoFile(jobId, photoId, request.userId, storage)
        return reply
          .header('Content-Type', mimeType)
          .header('Cache-Control', 'private, max-age=300')
          .send(bytes)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/photos/:photoId — descriptor/link metadata
  fastify.patch<{
    Params: { jobId: string; photoId: string }
    Body: { descriptor?: string | null; linkedNoteId?: string | null; linkedMemoryItemId?: string | null }
  }>('/api/jobs/:jobId/photos/:photoId', async (request, reply) => {
    try {
      const { jobId, photoId } = request.params
      const body = request.body ?? {}
      const result = await patchJobPhoto(jobId, photoId, request.userId, body)
      return reply.send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

export default photosRoutes
