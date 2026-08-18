import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { getCurrentJob, listJobs, getJob, createJob, patchJob } from '../services/jobs.js'
import { ErrorCode } from '../types/errors.js'

const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/jobs/current', async (request, reply) => {
    try {
      const job = await getCurrentJob(request.userId)
      return reply.send(job)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  fastify.get('/api/jobs', async (request, reply) => {
    const jobs = await listJobs(request.userId)
    return reply.send(jobs)
  })

  fastify.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
    try {
      const job = await getJob(request.params.jobId, request.userId)
      return reply.send(job)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  fastify.post('/api/jobs', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>
      const job = await createJob(request.userId, {
        title: body.title,
        jobType: body.jobType,
        roughLocationOrLabel: body.roughLocationOrLabel,
        status: body.status,
      })
      return reply.code(201).send(job)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })

  // PATCH /api/jobs/:jobId — owner-scoped edit of title and lightweight
  // status (archived is not settable here)
  fastify.patch<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { title?: unknown; status?: unknown }
      const job = await patchJob(request.params.jobId, request.userId, {
        title: body.title,
        status: body.status,
      })
      return reply.send(job)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

const STATUS_MAP: Record<string, number> = {
  [ErrorCode.JOB_NOT_FOUND]: 404,
  [ErrorCode.NOTE_NOT_FOUND]: 404,
  [ErrorCode.CANDIDATE_FACT_NOT_FOUND]: 404,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.AUDIO_UNSUPPORTED_TYPE]: 415,
  [ErrorCode.AUDIO_TOO_LARGE]: 413,
  [ErrorCode.NOTE_DUPLICATE_CLIENT_ID]: 409,
  [ErrorCode.ALREADY_REVIEWED]: 409,
  [ErrorCode.MISSING_FIELD]: 400,
  [ErrorCode.INVALID_FIELD]: 400,
  [ErrorCode.MEMORY_ITEM_NOT_FOUND]: 404,
  [ErrorCode.BUDGET_CATEGORY_NOT_FOUND]: 404,
  [ErrorCode.BUDGET_CATEGORY_ARCHIVED]: 400,
  [ErrorCode.PHOTO_UNSUPPORTED_TYPE]: 415,
  [ErrorCode.PHOTO_TOO_LARGE]: 413,
  [ErrorCode.PHOTO_NOT_FOUND]: 404,
  [ErrorCode.PHOTO_LINK_TARGET_NOT_FOUND]: 404,
  [ErrorCode.RECEIPT_UNSUPPORTED_TYPE]: 415,
  [ErrorCode.RECEIPT_TOO_LARGE]: 413,
  [ErrorCode.RECEIPT_NOT_FOUND]: 404,
  [ErrorCode.USER_NOT_FOUND]: 404,
  [ErrorCode.PAYMENT_NOT_FOUND]: 404,
  [ErrorCode.MONEY_EVENT_NOT_FOUND]: 404,
  [ErrorCode.MONEY_EVENT_ALREADY_EXISTS]: 400,
  [ErrorCode.LABOUR_PERSON_NOT_FOUND]: 404,
  [ErrorCode.LABOUR_PERSON_ALREADY_EXISTS]: 400,
  [ErrorCode.JOB_CONTACT_NOT_FOUND]: 404,
  [ErrorCode.SUPPLIER_PAYMENT_NOT_FOUND]: 404,
  // The feature is off for this deployment, not for this user's data: the
  // request is understood and refused, so 403 rather than 404 or 400.
  [ErrorCode.SUPPLIER_SETTLEMENT_DISABLED]: 403,
  // A settlement is written against a selection Mike made moments ago; if any
  // covered cost changed underneath it, nothing is written and the client is
  // told to re-read the account (409, not 400 — the request was well-formed).
  [ErrorCode.SUPPLIER_PAYMENT_STALE_SELECTION]: 409,
  [ErrorCode.SUPPLIER_PAYMENT_OWNS_COST]: 400,
  [ErrorCode.WORKSHOP_ITEM_NOT_FOUND]: 404,
  [ErrorCode.WORKSHOP_SOURCE_NOT_FOUND]: 404,
  // The source leftover is already in the Workshop: a well-formed request that
  // would create a second availability record for the same real material.
  [ErrorCode.WORKSHOP_SOURCE_ALREADY_MOVED]: 400,
  [ErrorCode.WORKSHOP_INVALID_STATE]: 400,
}

export function handleServiceError(err: unknown, reply: FastifyReply) {
  if (isApiError(err)) {
    return reply.code(STATUS_MAP[err.code] ?? 400).send(err)
  }
  throw err
}

export function isApiError(err: unknown): err is { code: string; message: string } {
  return typeof err === 'object' && err !== null && 'code' in err && 'message' in err
}

export default jobsRoutes
