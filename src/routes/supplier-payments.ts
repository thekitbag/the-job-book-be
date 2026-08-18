import type { FastifyPluginAsync } from 'fastify'
import {
  createSupplierAccountPayment,
  getSupplierAccountPayment,
  patchSupplierAccountPaymentDate,
  undoSupplierAccountPayment,
} from '../services/supplier-payments.js'
import { handleServiceError } from './jobs.js'

// Supplier account settlement: one aggregate named-supplier payment across jobs.
// Registered under /api/book because a settlement belongs to Mike's book, not to
// any single job — the jobs are the allocation, not the owner.
//
// The three write routes are gated by SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED
// (default off) and return 403 SUPPLIER_SETTLEMENT_DISABLED when it is not set.
// The gate is enforced in the service, so it holds however the write is reached.
// Reads stay open: a receipt recorded while the feature was on must not become
// unreachable if it is turned off.
const supplierPaymentRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/book/money/supplier-payments — record one aggregate payment.
  // 201 for a new payment, 200 when an idempotent retry returns the existing
  // receipt (the same convention as idempotent note upload).
  fastify.post('/api/book/money/supplier-payments', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>
      const { receipt, created } = await createSupplierAccountPayment(request.userId, body)
      return reply.code(created ? 201 : 200).send(receipt)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // GET /api/book/money/supplier-payments/:paymentId — the durable receipt.
  fastify.get<{ Params: { paymentId: string } }>(
    '/api/book/money/supplier-payments/:paymentId',
    async (request, reply) => {
      try {
        return reply.send(await getSupplierAccountPayment(request.userId, request.params.paymentId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/book/money/supplier-payments/:paymentId — payment date only.
  fastify.patch<{ Params: { paymentId: string } }>(
    '/api/book/money/supplier-payments/:paymentId',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as { paidAt?: unknown }
        return reply.send(
          await patchSupplierAccountPaymentDate(request.userId, request.params.paymentId, body),
        )
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // DELETE /api/book/money/supplier-payments/:paymentId — aggregate Undo.
  // Returns the receipt with isDeleted: true so the client can show what was
  // undone before refetching the authoritative read models.
  fastify.delete<{ Params: { paymentId: string } }>(
    '/api/book/money/supplier-payments/:paymentId',
    async (request, reply) => {
      try {
        return reply.send(await undoSupplierAccountPayment(request.userId, request.params.paymentId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default supplierPaymentRoutes
