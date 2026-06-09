import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import {
  createOrGetTidyUp,
  getTidyUpById,
  getTidyUpByDate,
  submitTidyUpDecision,
} from '../services/tidy-up.js'

const tidyUpRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/jobs/:jobId/tidy-ups — create or return existing run for a date
  fastify.post<{
    Params: { jobId: string }
    Body: { localDate?: string; forceRefresh?: boolean }
  }>('/api/jobs/:jobId/tidy-ups', async (request, reply) => {
    const { jobId } = request.params
    const { localDate, forceRefresh = false } = request.body ?? {}

    if (!localDate) {
      return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'localDate is required' })
    }

    try {
      const result = await createOrGetTidyUp(jobId, request.userId, localDate, forceRefresh)
      return reply.send(result)
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
      if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
      throw err
    }
  })

  // GET /api/jobs/:jobId/tidy-ups/:tidyUpId — get run by ID
  fastify.get<{ Params: { jobId: string; tidyUpId: string } }>(
    '/api/jobs/:jobId/tidy-ups/:tidyUpId',
    async (request, reply) => {
      const { jobId, tidyUpId } = request.params

      try {
        const result = await getTidyUpById(jobId, request.userId, tidyUpId)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string }
        if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
        if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
        if (e.code === ErrorCode.TIDY_UP_NOT_FOUND) return reply.code(404).send(e)
        throw err
      }
    },
  )

  // GET /api/jobs/:jobId/tidy-ups?localDate= — get most recent run for a date
  fastify.get<{ Params: { jobId: string }; Querystring: { localDate?: string } }>(
    '/api/jobs/:jobId/tidy-ups',
    async (request, reply) => {
      const { jobId } = request.params
      const { localDate } = request.query

      if (!localDate) {
        return reply
          .code(400)
          .send({ code: ErrorCode.MISSING_FIELD, message: 'localDate query parameter is required' })
      }

      try {
        const result = await getTidyUpByDate(jobId, request.userId, localDate)
        return reply.send(result)
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string }
        if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
        if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
        if (e.code === ErrorCode.TIDY_UP_NOT_FOUND) return reply.code(404).send(e)
        throw err
      }
    },
  )

  // POST /api/jobs/:jobId/tidy-up-decisions — submit a decision on a tidy-up item
  fastify.post<{
    Params: { jobId: string }
    Body: {
      tidyUpItemId?: string
      action?: string
      corrected?: {
        memoryType?: string
        summary?: string
        materialName?: string | null
        quantity?: string | null
        unit?: string | null
        supplierName?: string | null
        deliveryTiming?: string | null
        locationOrUse?: string | null
      }
      reason?: string
    }
  }>('/api/jobs/:jobId/tidy-up-decisions', async (request, reply) => {
    const { jobId } = request.params
    const body = request.body ?? {}

    const missing = (field: string) =>
      reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: `${field} is required` })

    if (!body.tidyUpItemId) return missing('tidyUpItemId')
    if (!body.action) return missing('action')

    const validActions = ['confirm', 'correct', 'reject', 'leave_unconfirmed']
    if (!validActions.includes(body.action)) {
      return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'unknown action' })
    }

    if (body.action === 'correct') {
      if (!body.corrected?.summary) return missing('corrected.summary')
    }

    try {
      const result = await submitTidyUpDecision(jobId, request.userId, {
        tidyUpItemId: body.tidyUpItemId,
        action: body.action as 'confirm' | 'correct' | 'reject' | 'leave_unconfirmed',
        corrected: body.corrected as never,
        reason: body.reason,
      })
      return reply.send(result)
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string }
      if (e.code === ErrorCode.JOB_NOT_FOUND) return reply.code(404).send(e)
      if (e.code === ErrorCode.FORBIDDEN) return reply.code(403).send(e)
      if (e.code === ErrorCode.TIDY_UP_ITEM_NOT_FOUND) return reply.code(404).send(e)
      if (e.code === ErrorCode.TIDY_UP_ITEM_ALREADY_DECIDED) return reply.code(409).send(e)
      if (e.code === ErrorCode.CONTRADICTION_CONFIRM_NOT_ALLOWED) return reply.code(409).send(e)
      throw err
    }
  })
}

export default tidyUpRoutes
