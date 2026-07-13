// Founder Support Mode routes: GET-only, account-auth based (no inspection
// key), gated on User.role === INTERNAL. Read-only is enforced at the API
// boundary — this plugin deliberately registers no POST/PATCH/PUT/DELETE.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'
import {
  listSupportUsers,
  listSupportUserJobs,
  getSupportJobInspection,
  getSupportMemoryView,
  getSupportBudgetSummary,
  getSupportReviewQueue,
  getSupportJobPhotos,
  getSupportJobPhotoFile,
  getSupportJobPayments,
} from '../services/support.js'
import { handleServiceError } from './jobs.js'

interface SupportRouteOptions {
  storage: AudioStorageProvider
}

// The auth plugin has already 401'd unauthenticated requests; this guard adds
// the internal-role boundary. Returns true when the request was refused.
function refuseNonInternal(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.userRole !== 'INTERNAL') {
    reply.code(403).send({ code: ErrorCode.FORBIDDEN, message: 'Internal access only' })
    return true
  }
  return false
}

const supportRoutes: FastifyPluginAsync<SupportRouteOptions> = async (fastify, opts) => {
  const { storage } = opts

  fastify.get('/api/internal/support/users', async (request, reply) => {
    if (refuseNonInternal(request, reply)) return
    try {
      return reply.send(await listSupportUsers(request.userId))
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  fastify.get<{ Params: { targetUserId: string } }>(
    '/api/internal/support/users/:targetUserId/jobs',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await listSupportUserJobs(request.userId, request.params.targetUserId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/inspection',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportJobInspection(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/memory-view',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportMemoryView(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/budget-summary',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportBudgetSummary(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/review-queue',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportReviewQueue(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/photos',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportJobPhotos(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/support/jobs/:jobId/payments',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        return reply.send(await getSupportJobPayments(request.userId, request.params.jobId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string; photoId: string } }>(
    '/api/internal/support/jobs/:jobId/photos/:photoId/file',
    async (request, reply) => {
      if (refuseNonInternal(request, reply)) return
      try {
        const { jobId, photoId } = request.params
        const { bytes, mimeType } = await getSupportJobPhotoFile(request.userId, jobId, photoId, storage)
        return reply
          .header('Content-Type', mimeType)
          .header('Cache-Control', 'private, max-age=300')
          .send(bytes)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default supportRoutes
