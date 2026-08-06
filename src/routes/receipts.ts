import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'
import {
  createJobReceipt,
  listJobReceipts,
  getJobReceiptFile,
  patchJobReceipt,
  deleteJobReceipt,
} from '../services/receipts.js'
import { handleServiceError } from './jobs.js'

interface ReceiptsRouteOptions {
  storage: AudioStorageProvider
}

// A safe Content-Disposition for the stored original file name: quotes and
// backslashes escaped, non-ASCII dropped from the plain parameter and carried
// by the RFC 5987 filename* form instead.
function contentDisposition(originalFileName: string | null): string {
  if (!originalFileName) return 'inline'
  const ascii = originalFileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`
}

const receiptsRoutes: FastifyPluginAsync<ReceiptsRouteOptions> = async (fastify, opts) => {
  const { storage } = opts

  // POST /api/jobs/:jobId/receipts — multipart receipt/invoice upload.
  // Evidence storage only: no OCR, spend, Budget, Money, or memory side effects.
  fastify.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/receipts',
    async (request, reply) => {
      const { jobId } = request.params
      try {
        const parts = request.parts()

        let descriptor: string | undefined
        let mimeType: string | undefined
        let originalFileName: string | undefined
        let fileBuffer: Buffer | undefined

        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'descriptor') descriptor = part.value as string
          } else if (part.type === 'file' && part.fieldname === 'file' && fileBuffer === undefined) {
            const chunks: Buffer[] = []
            for await (const chunk of part.file) chunks.push(chunk)
            fileBuffer = Buffer.concat(chunks)
            mimeType = part.mimetype
            originalFileName = part.filename
          } else if (part.type === 'file') {
            // v1 accepts a single file per upload; drain anything else so the
            // request stream completes cleanly.
            for await (const _chunk of part.file) void _chunk
          }
        }

        if (!fileBuffer || fileBuffer.byteLength === 0 || !mimeType) {
          return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'file is required' })
        }

        const result = await createJobReceipt(
          {
            jobId,
            userId: request.userId,
            fileBuffer,
            mimeType,
            descriptor: descriptor ?? null,
            originalFileName: originalFileName ?? null,
          },
          storage,
        )
        return reply.code(201).send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // GET /api/jobs/:jobId/receipts — receipt/invoice evidence only, newest first
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/receipts',
    async (request, reply) => {
      try {
        const result = await listJobReceipts(request.params.jobId, request.userId)
        return reply.send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // GET /api/jobs/:jobId/receipts/:receiptId/file — authenticated raw bytes
  fastify.get<{ Params: { jobId: string; receiptId: string } }>(
    '/api/jobs/:jobId/receipts/:receiptId/file',
    async (request, reply) => {
      try {
        const { jobId, receiptId } = request.params
        const { bytes, mimeType, originalFileName } = await getJobReceiptFile(
          jobId,
          receiptId,
          request.userId,
          storage,
        )
        return reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', contentDisposition(originalFileName))
          .header('Cache-Control', 'private, max-age=300')
          .send(bytes)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/receipts/:receiptId — descriptor only
  fastify.patch<{
    Params: { jobId: string; receiptId: string }
    Body: { descriptor?: string | null }
  }>('/api/jobs/:jobId/receipts/:receiptId', async (request, reply) => {
    try {
      const { jobId, receiptId } = request.params
      const result = await patchJobReceipt(jobId, receiptId, request.userId, request.body ?? {})
      return reply.send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // DELETE /api/jobs/:jobId/receipts/:receiptId — soft remove; the stored
  // object is kept, only active reads stop showing it
  fastify.delete<{
    Params: { jobId: string; receiptId: string }
  }>('/api/jobs/:jobId/receipts/:receiptId', async (request, reply) => {
    try {
      const { jobId, receiptId } = request.params
      await deleteJobReceipt(jobId, receiptId, request.userId)
      return reply.code(204).send()
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

export default receiptsRoutes
