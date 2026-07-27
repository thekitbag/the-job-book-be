import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import {
  listLabourPeople,
  createLabourPerson,
  patchLabourPerson,
  MAX_LABOUR_PERSON_NAME_LENGTH,
} from '../services/labour-people.js'
import { handleServiceError } from './jobs.js'
import {
  validateNonEmptyBoundedString,
  isValidDecimalString,
  validateOptionalGbpCurrency,
} from '../lib/request-validation.js'
import type { ValidationError } from '../lib/request-validation.js'

function sendError(reply: FastifyReply, error: ValidationError) {
  return reply.code(400).send(error)
}

// Shared rate validation: null clears (patch), a present value must be strict
// non-negative GBP decimal. Zero is an intentional job-local no-cost rate.
function rateError(amount: unknown, currency: unknown): ValidationError | null {
  if (amount == null && currency != null) {
    return { code: ErrorCode.INVALID_FIELD, message: 'defaultHourlyRateCurrency requires defaultHourlyRateAmount' }
  }
  if (amount != null) {
    if (!isValidDecimalString(amount) || Number(amount) < 0) {
      return { code: ErrorCode.INVALID_FIELD, message: 'defaultHourlyRateAmount must be a non-negative decimal string' }
    }
  }
  return validateOptionalGbpCurrency(currency, 'defaultHourlyRateCurrency')
}

interface CreateBody {
  name?: string
  defaultHourlyRateAmount?: string | null
  defaultHourlyRateCurrency?: string | null
}
interface PatchBody extends CreateBody {}

const labourPeopleRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/jobs/:jobId/labour-people — active people for the owner + job stats
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/labour-people',
    async (request, reply) => {
      try {
        return reply.send(await listLabourPeople(request.params.jobId, request.userId))
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // POST /api/jobs/:jobId/labour-people — create a labour person
  fastify.post<{ Params: { jobId: string }; Body: CreateBody }>(
    '/api/jobs/:jobId/labour-people',
    async (request, reply) => {
      const body = request.body ?? {}
      if (body.name == null) {
        return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'name is required' })
      }
      const error =
        validateNonEmptyBoundedString(body.name, 'name', MAX_LABOUR_PERSON_NAME_LENGTH) ??
        rateError(body.defaultHourlyRateAmount, body.defaultHourlyRateCurrency)
      if (error) return sendError(reply, error)

      try {
        const person = await createLabourPerson(request.params.jobId, request.userId, {
          name: body.name,
          defaultHourlyRateAmount: body.defaultHourlyRateAmount,
          defaultHourlyRateCurrency: body.defaultHourlyRateCurrency,
        })
        return reply.code(201).send(person)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  // PATCH /api/jobs/:jobId/labour-people/:personId — edit a person's defaults
  fastify.patch<{ Params: { jobId: string; personId: string }; Body: PatchBody }>(
    '/api/jobs/:jobId/labour-people/:personId',
    async (request, reply) => {
      const body = request.body ?? {}
      const error =
        (body.name !== undefined ? validateNonEmptyBoundedString(body.name, 'name', MAX_LABOUR_PERSON_NAME_LENGTH) : null) ??
        rateError(body.defaultHourlyRateAmount, body.defaultHourlyRateCurrency)
      if (error) return sendError(reply, error)

      try {
        const { jobId, personId } = request.params
        const person = await patchLabourPerson(jobId, personId, request.userId, {
          name: body.name,
          defaultHourlyRateAmount: body.defaultHourlyRateAmount,
          defaultHourlyRateCurrency: body.defaultHourlyRateCurrency,
        })
        return reply.send(person)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default labourPeopleRoutes
