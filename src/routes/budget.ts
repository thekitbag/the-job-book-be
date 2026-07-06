import type { FastifyPluginAsync } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { handleServiceError } from './jobs.js'
import {
  listBudgetCategories,
  createBudgetCategory,
  patchBudgetCategory,
  getBudgetSummary,
} from '../services/budget.js'

import {
  validateNonEmptyBoundedString,
  validateOptionalNonNegativeDecimal,
  validateOptionalGbpCurrency,
  validateOptionalNonNegativeInteger,
  validateOptionalBoolean,
} from '../lib/request-validation.js'

const NAME_MAX_LENGTH = 60

interface CategoryBody {
  name?: unknown
  budgetAmount?: unknown
  budgetCurrency?: unknown
  sortOrder?: unknown
  isArchived?: unknown
}

// Shared field-shape validation. Returns an error, or null when valid.
// `requireName` is true for POST (name mandatory) and false for PATCH.
function validateCategoryBody(body: CategoryBody, requireName: boolean): { code: string; message: string } | null {
  if (requireName && body.name === undefined) {
    return { code: ErrorCode.MISSING_FIELD, message: 'name is required' }
  }
  return (
    (body.name !== undefined ? validateNonEmptyBoundedString(body.name, 'name', NAME_MAX_LENGTH) : null) ??
    validateOptionalNonNegativeDecimal(body.budgetAmount, 'budgetAmount') ??
    validateOptionalGbpCurrency(body.budgetCurrency, 'budgetCurrency') ??
    validateOptionalNonNegativeInteger(body.sortOrder, 'sortOrder') ??
    validateOptionalBoolean(body.isArchived, 'isArchived')
  )
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
