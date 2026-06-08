import type { FastifyPluginAsync } from 'fastify'
import { getReviewDraft, submitReviewDecision, listMemory } from '../services/review.js'
import type { ReviewDecisionPayload } from '../services/review.js'
import { handleServiceError } from './jobs.js'
import { ErrorCode } from '../types/errors.js'

const reviewRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/review-draft',
    async (request, reply) => {
      try {
        const draft = await getReviewDraft(request.params.jobId, request.userId)
        return reply.send(draft)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.post<{ Params: { jobId: string }; Body: ReviewDecisionPayload }>(
    '/api/jobs/:jobId/review-decisions',
    async (request, reply) => {
      try {
        const payload = request.body
        if (!payload?.action) {
          return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'action is required' })
        }
        const result = await submitReviewDecision(request.params.jobId, request.userId, payload)
        return reply.code(201).send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/memory',
    async (request, reply) => {
      try {
        const items = await listMemory(request.params.jobId, request.userId)
        return reply.send(items)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default reviewRoutes
