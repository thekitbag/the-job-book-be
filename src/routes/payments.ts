import type { FastifyPluginAsync } from 'fastify'
import {
  getJobPayments,
  patchCustomerTotal,
  createPayment,
  patchPayment,
  deletePayment,
} from '../services/payments.js'
import { handleServiceError } from './jobs.js'

const paymentsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/jobs/:jobId/payments — summary + active history, newest first
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/payments',
    async (request, reply) => {
      try {
        return reply.send(await getJobPayments(request.params.jobId, request.userId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/payments/customer-total — set/clear the job total
  fastify.patch<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/payments/customer-total',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>
        return reply.send(await patchCustomerTotal(request.params.jobId, request.userId, body))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // POST /api/jobs/:jobId/payments — record a payment received
  fastify.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/payments',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>
        const payment = await createPayment(request.params.jobId, request.userId, body)
        return reply.code(201).send(payment)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/payments/:paymentId — edit an active payment
  fastify.patch<{ Params: { jobId: string; paymentId: string } }>(
    '/api/jobs/:jobId/payments/:paymentId',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Record<string, unknown>
        const { jobId, paymentId } = request.params
        return reply.send(await patchPayment(jobId, paymentId, request.userId, body))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // DELETE /api/jobs/:jobId/payments/:paymentId — soft delete
  fastify.delete<{ Params: { jobId: string; paymentId: string } }>(
    '/api/jobs/:jobId/payments/:paymentId',
    async (request, reply) => {
      try {
        const { jobId, paymentId } = request.params
        await deletePayment(jobId, paymentId, request.userId)
        return reply.code(204).send()
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default paymentsRoutes
