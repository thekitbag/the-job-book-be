import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { getReviewQueue, submitQueueDecision, VALID_MEMORY_TYPES } from '../services/review-queue.js'

// Decimal string: optional digits, optional dot, optional further digits; not empty.
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/

function isValidDecimalString(v: unknown): boolean {
  return typeof v === 'string' && DECIMAL_STRING_RE.test(v)
}

const reviewQueueRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/jobs/:jobId/review-queue
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/review-queue',
    async (request, reply) => {
      const { jobId } = request.params
      try {
        const result = await getReviewQueue(jobId, request.userId)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string }
        if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
        if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
        throw err
      }
    },
  )

  // POST /api/jobs/:jobId/review-queue-decisions
  fastify.post<{
    Params: { jobId: string }
    Body: {
      queueItemId?: string
      action?: string
      uncertaintyResolution?: string
      corrected?: {
        memoryType?: string
        summary?: string
        materialName?: string | null
        quantity?: string | null
        unit?: string | null
        supplierName?: string | null
        deliveryTiming?: string | null
        locationOrUse?: string | null
        costAmount?: string | null
        costCurrency?: string | null
        costQualifier?: string | null
        totalCostAmount?: string | null
      }
      reason?: string
    }
  }>('/api/jobs/:jobId/review-queue-decisions', async (request, reply) => {
    const { jobId } = request.params
    const body = request.body ?? {}

    const missing = (field: string) =>
      reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: `${field} is required` })

    if (!body.queueItemId) return missing('queueItemId')
    if (!body.action) return missing('action')

    const validActions = ['confirm', 'correct', 'dismiss']
    if (!validActions.includes(body.action)) {
      return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'action must be confirm, correct, or dismiss' })
    }

    const VALID_UNCERTAINTY_RESOLUTIONS = new Set(['resolved', 'still_unsure'])
    if (body.uncertaintyResolution != null && !VALID_UNCERTAINTY_RESOLUTIONS.has(body.uncertaintyResolution)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'uncertaintyResolution must be resolved or still_unsure' })
    }

    if (body.action === 'correct') {
      if (!body.corrected?.summary) return missing('corrected.summary')
      if (!body.corrected?.memoryType) return missing('corrected.memoryType')
      if (!VALID_MEMORY_TYPES.has(body.corrected.memoryType)) {
        return reply.code(400).send({
          code: ErrorCode.INVALID_FIELD,
          message: 'corrected.memoryType must be a valid non-unclear memory type',
        })
      }
      const c = body.corrected
      if (c.costAmount != null && !isValidDecimalString(c.costAmount)) {
        return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'corrected.costAmount must be a decimal string' })
      }
      if (c.totalCostAmount != null && !isValidDecimalString(c.totalCostAmount)) {
        return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'corrected.totalCostAmount must be a decimal string' })
      }
      const VALID_QUALIFIERS = new Set(['each', 'total', 'approx', 'unknown'])
      if (c.costQualifier != null && !VALID_QUALIFIERS.has(c.costQualifier)) {
        return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'corrected.costQualifier must be each, total, approx, or unknown' })
      }
    }

    try {
      const result = await submitQueueDecision(jobId, request.userId, {
        queueItemId: body.queueItemId,
        action: body.action as 'confirm' | 'correct' | 'dismiss',
        uncertaintyResolution: body.uncertaintyResolution as 'resolved' | 'still_unsure' | undefined,
        corrected: body.corrected as never,
        reason: body.reason,
      })
      return reply.send(result)
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
      if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
      if (e.code === ErrorCode.QUEUE_ITEM_NOT_FOUND) return reply.code(404).send(e)
      if (e.code === ErrorCode.QUEUE_ITEM_ALREADY_DECIDED) return reply.code(409).send(e)
      if (e.code === ErrorCode.QUEUE_ITEM_CONFIRM_NOT_ALLOWED) return reply.code(409).send(e)
      throw err
    }
  })
}

export default reviewQueueRoutes
