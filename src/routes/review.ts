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
        const missing = (field: string) =>
          reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: `${field} is required` })

        if (!payload?.action) return missing('action')

        switch (payload.action) {
          case 'confirm':
            if (!payload.candidateFactId) return missing('candidateFactId')
            break
          case 'correct':
            if (!payload.candidateFactId) return missing('candidateFactId')
            if (!payload.corrected?.summary) return missing('corrected.summary')
            break
          case 'reject':
            if (!payload.candidateFactId) return missing('candidateFactId')
            break
          case 'confirm_section':
            if (!payload.sectionKey) return missing('sectionKey')
            if (!Array.isArray(payload.candidateFactIds) || payload.candidateFactIds.length === 0)
              return missing('candidateFactIds')
            break
          case 'add_missing':
            if (!payload.memoryType) return missing('memoryType')
            if (!payload.memory) return missing('memory')
            if (!payload.memory.summary) return missing('memory.summary')
            break
          default:
            return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'unknown action' })
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
