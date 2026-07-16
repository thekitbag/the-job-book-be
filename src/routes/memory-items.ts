import type { FastifyPluginAsync } from 'fastify'
import type { FastifyReply } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { patchMemoryItem, verifyMemoryItem, createMemoryItem, removeMemoryItem, returnMaterial } from '../services/memory-items.js'
import { handleServiceError } from './jobs.js'
import {
  validateOptionalDecimal,
  validateOptionalCostQualifier,
  validateOptionalUncertaintyResolution,
  validateMemoryTargetType,
  validateBudgetCategoryRef,
  isValidDecimalString,
  validateOptionalGbpCurrency,
  validateOptionalIsoDate,
} from '../lib/request-validation.js'
import type { ValidationError } from '../lib/request-validation.js'

// Runs the shared field validators that apply to both create and patch bodies;
// returns the first error, or null when every present field is acceptable.
function memoryFieldsError(body: {
  costAmount?: unknown
  totalCostAmount?: unknown
  labourHours?: unknown
  costQualifier?: unknown
  budgetCategoryId?: unknown
}): ValidationError | null {
  return (
    validateOptionalDecimal(body.costAmount, 'costAmount') ??
    validateOptionalDecimal(body.totalCostAmount, 'totalCostAmount') ??
    validateOptionalDecimal(body.labourHours, 'labourHours') ??
    validateOptionalCostQualifier(body.costQualifier) ??
    ('budgetCategoryId' in body ? validateBudgetCategoryRef(body.budgetCategoryId) : null)
  )
}

function sendError(reply: FastifyReply, error: ValidationError) {
  return reply.code(400).send(error)
}

interface CreateBody {
  memoryType?: string
  summary?: string | null
  happenedAt?: string | null
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
  labourHours?: string | null
  labourPerson?: string | null
  labourTask?: string | null
  budgetCategoryId?: string | null
}

const memoryItemsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/jobs/:jobId/memory-items — direct add (trusted manual memory)
  fastify.post<{ Params: { jobId: string }; Body: CreateBody }>(
    '/api/jobs/:jobId/memory-items',
    async (request, reply) => {
      const { jobId } = request.params
      const body = request.body ?? {}

      if (!body.memoryType) {
        return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'memoryType is required' })
      }
      const error = validateMemoryTargetType(body.memoryType) ?? memoryFieldsError(body)
      if (error) return sendError(reply, error)

      try {
        const result = await createMemoryItem(jobId, request.userId, body as never)
        return reply.code(201).send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.patch<{
    Params: { jobId: string; memoryItemId: string }
    Body: {
      memoryType?: string
      summary?: string | null
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
      labourHours?: string | null
      labourPerson?: string | null
      labourTask?: string | null
      happenedAt?: string | null
      uncertaintyResolution?: string
      budgetCategoryId?: string | null
    }
  }>('/api/jobs/:jobId/memory-items/:memoryItemId', async (request, reply) => {
    const { jobId, memoryItemId } = request.params
    const body = request.body ?? {}

    // A category-only change carries budgetCategoryId and no memoryType; it must
    // update only the assignment and leave existing memory fields untouched.
    if (body.memoryType == null) {
      if (!('budgetCategoryId' in body)) {
        return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'memoryType or budgetCategoryId is required' })
      }
    } else {
      const typeError = validateMemoryTargetType(body.memoryType)
      if (typeError) return sendError(reply, typeError)
    }
    // Field order matches the original checks so the first-reported error for
    // multi-invalid bodies is unchanged.
    const error =
      validateOptionalDecimal(body.costAmount, 'costAmount') ??
      validateOptionalDecimal(body.totalCostAmount, 'totalCostAmount') ??
      validateOptionalCostQualifier(body.costQualifier) ??
      validateOptionalDecimal(body.labourHours, 'labourHours') ??
      validateOptionalUncertaintyResolution(body.uncertaintyResolution) ??
      ('budgetCategoryId' in body ? validateBudgetCategoryRef(body.budgetCategoryId) : null)
    if (error) return sendError(reply, error)

    try {
      const result = await patchMemoryItem(jobId, memoryItemId, request.userId, body as never)
      return reply.send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // DELETE /api/jobs/:jobId/memory-items/:memoryItemId — soft-remove from the
  // active job record; source evidence is preserved
  fastify.delete<{
    Params: { jobId: string; memoryItemId: string }
  }>('/api/jobs/:jobId/memory-items/:memoryItemId', async (request, reply) => {
    const { jobId, memoryItemId } = request.params
    try {
      await removeMemoryItem(jobId, memoryItemId, request.userId)
      return reply.code(204).send()
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // POST /api/jobs/:jobId/memory-items/:memoryItemId/return — move all or part of
  // a Left over item to Returned, recording merchant/refund/date. Full return
  // soft-removes the source leftover; partial return reduces its quantity.
  fastify.post<{
    Params: { jobId: string; memoryItemId: string }
    Body: {
      quantity?: string | null
      unit?: string | null
      supplierName?: string | null
      refundAmount?: string | null
      refundCurrency?: string | null
      happenedAt?: string | null
    }
  }>('/api/jobs/:jobId/memory-items/:memoryItemId/return', async (request, reply) => {
    const { jobId, memoryItemId } = request.params
    const body = request.body ?? {}

    if (body.quantity == null) {
      return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'quantity is required' })
    }
    // Shape validation (strict positive decimals; numeric bounds vs. the leftover
    // are enforced in the service). refundAmount must be a positive decimal too.
    if (!isValidDecimalString(body.quantity) || Number(body.quantity) <= 0) {
      return sendError(reply, { code: ErrorCode.INVALID_FIELD, message: 'quantity must be a positive decimal string' })
    }
    if (body.refundAmount != null) {
      if (!isValidDecimalString(body.refundAmount) || Number(body.refundAmount) <= 0) {
        return sendError(reply, { code: ErrorCode.INVALID_FIELD, message: 'refundAmount must be a positive decimal string' })
      }
    }
    const error =
      validateOptionalGbpCurrency(body.refundCurrency, 'refundCurrency') ??
      validateOptionalIsoDate(body.happenedAt, 'happenedAt')
    if (error) return sendError(reply, error)

    try {
      const result = await returnMaterial(jobId, memoryItemId, request.userId, body)
      return reply.code(201).send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  fastify.post<{
    Params: { jobId: string; memoryItemId: string }
  }>('/api/jobs/:jobId/memory-items/:memoryItemId/verify', async (request, reply) => {
    const { jobId, memoryItemId } = request.params
    try {
      const result = await verifyMemoryItem(jobId, memoryItemId, request.userId)
      return reply.send(result)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

export default memoryItemsRoutes
