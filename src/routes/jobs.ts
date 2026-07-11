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
      const body = request.body as Record<string, unknown> | null | undefined
      const job = await createJob(request.userId, body?.title, body?.jobType)
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
  [ErrorCode.USER_NOT_FOUND]: 404,
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
