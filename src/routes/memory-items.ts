import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { VALID_MEMORY_TYPES } from '../services/review-queue.js'
import { patchMemoryItem, verifyMemoryItem, createMemoryItem } from '../services/memory-items.js'
import { handleServiceError } from './jobs.js'

const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/
function isValidDecimalString(v: unknown): boolean {
  return typeof v === 'string' && DECIMAL_STRING_RE.test(v)
}
const VALID_QUALIFIERS = new Set(['each', 'total', 'approx', 'unknown', 'per_hour'])
const VALID_UNCERTAINTY_RESOLUTIONS = new Set(['resolved', 'still_unsure'])

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
      const invalid = (message: string) =>
        reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message })

      if (!body.memoryType) {
        return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'memoryType is required' })
      }
      if (!VALID_MEMORY_TYPES.has(body.memoryType)) {
        return invalid('memoryType must be a valid non-unclear memory type')
      }
      if (body.costAmount != null && !isValidDecimalString(body.costAmount)) return invalid('costAmount must be a decimal string')
      if (body.totalCostAmount != null && !isValidDecimalString(body.totalCostAmount)) return invalid('totalCostAmount must be a decimal string')
      if (body.labourHours != null && !isValidDecimalString(body.labourHours)) return invalid('labourHours must be a decimal string')
      if (body.costQualifier != null && !VALID_QUALIFIERS.has(body.costQualifier)) return invalid('costQualifier must be each, total, per_hour, approx, or unknown')
      if ('budgetCategoryId' in body && body.budgetCategoryId !== null && typeof body.budgetCategoryId !== 'string') {
        return invalid('budgetCategoryId must be a string or null')
      }

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
    } else if (!VALID_MEMORY_TYPES.has(body.memoryType)) {
      return reply.code(400).send({
        code: ErrorCode.INVALID_FIELD,
        message: 'memoryType must be a valid non-unclear memory type',
      })
    }
    if (body.costAmount != null && !isValidDecimalString(body.costAmount)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'costAmount must be a decimal string' })
    }
    if (body.totalCostAmount != null && !isValidDecimalString(body.totalCostAmount)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'totalCostAmount must be a decimal string' })
    }
    if (body.costQualifier != null && !VALID_QUALIFIERS.has(body.costQualifier)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'costQualifier must be each, total, per_hour, approx, or unknown' })
    }
    if (body.labourHours != null && !isValidDecimalString(body.labourHours)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'labourHours must be a decimal string' })
    }
    if (body.uncertaintyResolution != null && !VALID_UNCERTAINTY_RESOLUTIONS.has(body.uncertaintyResolution)) {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'uncertaintyResolution must be resolved or still_unsure' })
    }
    if ('budgetCategoryId' in body && body.budgetCategoryId !== null && typeof body.budgetCategoryId !== 'string') {
      return reply.code(400).send({ code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId must be a string or null' })
    }

    try {
      const result = await patchMemoryItem(jobId, memoryItemId, request.userId, body as never)
      return reply.send(result)
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
