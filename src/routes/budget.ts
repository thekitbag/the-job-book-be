import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { handleServiceError } from './jobs.js'
import {
  listBudgetCategories,
  createBudgetCategory,
  patchBudgetCategory,
  getBudgetSummary,
} from '../services/budget.js'

const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/
const NAME_MAX_LENGTH = 60

function isNonNegativeDecimal(v: unknown): v is string {
  return typeof v === 'string' && DECIMAL_STRING_RE.test(v)
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

interface CategoryBody {
  name?: unknown
  budgetAmount?: unknown
  budgetCurrency?: unknown
  sortOrder?: unknown
  isArchived?: unknown
}

// Shared field-shape validation. Returns an error message, or null when valid.
// `requireName` is true for POST (name mandatory) and false for PATCH.
function validateCategoryBody(body: CategoryBody, requireName: boolean): { code: string; message: string } | null {
  const invalid = (message: string) => ({ code: ErrorCode.INVALID_FIELD, message })

  if (requireName || 'name' in body) {
    if (body.name === undefined && requireName) return { code: ErrorCode.MISSING_FIELD, message: 'name is required' }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) return invalid('name must be a non-empty string')
      if (body.name.trim().length > NAME_MAX_LENGTH) return invalid(`name must be at most ${NAME_MAX_LENGTH} characters`)
    }
  }
  if (body.budgetAmount !== undefined && body.budgetAmount !== null && !isNonNegativeDecimal(body.budgetAmount)) {
    return invalid('budgetAmount must be a non-negative decimal string')
  }
  if (body.budgetCurrency !== undefined && body.budgetCurrency !== null && body.budgetCurrency !== 'GBP') {
    return invalid('budgetCurrency must be GBP')
  }
  if (body.sortOrder !== undefined && body.sortOrder !== null && (!isInteger(body.sortOrder) || body.sortOrder < 0)) {
    return invalid('sortOrder must be a non-negative integer')
  }
  if (body.isArchived !== undefined && typeof body.isArchived !== 'boolean') {
    return invalid('isArchived must be a boolean')
  }
  return null
}

const budgetRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/budget-categories',
    async (request, reply) => {
      try {
        const categories = await listBudgetCategories(request.params.jobId, request.userId)
        return reply.send(categories)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.post<{ Params: { jobId: string }; Body: CategoryBody }>(
    '/api/jobs/:jobId/budget-categories',
    async (request, reply) => {
      const body = request.body ?? {}
      const error = validateCategoryBody(body, true)
      if (error) return reply.code(400).send(error)
      try {
        const created = await createBudgetCategory(request.params.jobId, request.userId, {
          name: body.name as string,
          budgetAmount: body.budgetAmount as string | null | undefined,
          budgetCurrency: body.budgetCurrency as string | null | undefined,
          sortOrder: body.sortOrder as number | undefined,
        })
        return reply.code(201).send(created)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.patch<{ Params: { jobId: string; categoryId: string }; Body: CategoryBody }>(
    '/api/jobs/:jobId/budget-categories/:categoryId',
    async (request, reply) => {
      const body = request.body ?? {}
      const error = validateCategoryBody(body, false)
      if (error) return reply.code(400).send(error)
      try {
        const updated = await patchBudgetCategory(
          request.params.jobId,
          request.params.categoryId,
          request.userId,
          {
            name: body.name as string | undefined,
            budgetAmount: body.budgetAmount as string | null | undefined,
            budgetCurrency: body.budgetCurrency as string | null | undefined,
            sortOrder: body.sortOrder as number | undefined,
            isArchived: body.isArchived as boolean | undefined,
          },
        )
        return reply.send(updated)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/budget-summary',
    async (request, reply) => {
      try {
        const summary = await getBudgetSummary(request.params.jobId, request.userId)
        return reply.send(summary)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default budgetRoutes
