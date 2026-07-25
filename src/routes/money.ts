import type { FastifyPluginAsync } from 'fastify'
import { getJobMoney, markMoneyOut, deleteMoneyEvent } from '../services/money.js'
import { handleServiceError } from './jobs.js'

const moneyRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/jobs/:jobId/money — unified Money in/out read model
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/money',
    async (request, reply) => {
      try {
        return reply.send(await getJobMoney(request.params.jobId, request.userId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // POST /api/jobs/:jobId/money/out — mark a trusted Budget cost item as paid
  fastify.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/money/out',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>
        return reply.send(await markMoneyOut(request.params.jobId, request.userId, body))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // DELETE /api/jobs/:jobId/money/events/:moneyEventId — soft-delete (Money-only correction)
  fastify.delete<{ Params: { jobId: string; moneyEventId: string } }>(
    '/api/jobs/:jobId/money/events/:moneyEventId',
    async (request, reply) => {
      try {
        const { jobId, moneyEventId } = request.params
        await deleteMoneyEvent(jobId, moneyEventId, request.userId)
        return reply.code(204).send()
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default moneyRoutes
