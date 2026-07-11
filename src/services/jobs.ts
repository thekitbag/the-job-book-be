import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

const JOB_SELECT = {
  id: true,
  title: true,
  jobType: true,
  status: true,
  roughLocationOrLabel: true,
  createdAt: true,
  updatedAt: true,
} as const

function normalizeJob(job: {
  id: string
  title: string
  jobType: string
  status: string
  roughLocationOrLabel: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: job.id,
    title: job.title,
    jobType: job.jobType,
    status: job.status.toLowerCase(),
    roughLocationOrLabel: job.roughLocationOrLabel,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

// Statuses visible in the normal job list/current reads. Archived jobs are
// the only hidden ones — planning or finishing a job must never make it vanish.
const VISIBLE_JOB_STATUSES = ['PLANNING', 'STARTED', 'FINISHED'] as const

// Current-job preference when several visible jobs exist.
const CURRENT_JOB_STATUS_PRIORITY = ['STARTED', 'PLANNING', 'FINISHED'] as const

export async function getCurrentJob(userId: string) {
  const jobs = await prisma.job.findMany({
    where: { ownerUserId: userId, status: { in: [...VISIBLE_JOB_STATUSES] } },
    orderBy: { updatedAt: 'desc' },
    select: JOB_SELECT,
  })

  // Most recently updated job of the highest-priority status present.
  for (const status of CURRENT_JOB_STATUS_PRIORITY) {
    const job = jobs.find((j) => j.status === status)
    if (job) return normalizeJob(job)
  }

  throw { code: ErrorCode.JOB_NOT_FOUND, message: 'No active job found' }
}

export async function listJobs(userId: string) {
  const jobs = await prisma.job.findMany({
    where: { ownerUserId: userId, status: { in: [...VISIBLE_JOB_STATUSES] } },
    select: JOB_SELECT,
    orderBy: { updatedAt: 'desc' },
  })
  return jobs.map(normalizeJob)
}

export const ALLOWED_JOB_TYPES = new Set(['garden_room', 'extension', 'other'])

export async function getJob(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { ownerUserId: true, ...JOB_SELECT },
  })

  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  return normalizeJob(job)
}

export const MAX_JOB_TITLE_LENGTH = 80

export async function createJob(userId: string, title: unknown, jobType: unknown) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : ''
  if (!trimmedTitle) throw { code: ErrorCode.MISSING_FIELD, message: 'title is required' }
  if (trimmedTitle.length > MAX_JOB_TITLE_LENGTH) throw { code: ErrorCode.INVALID_FIELD, message: 'title must be 80 characters or fewer' }

  const resolvedJobType = jobType === undefined || jobType === null ? 'other' : jobType
  if (typeof resolvedJobType !== 'string' || !ALLOWED_JOB_TYPES.has(resolvedJobType)) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'jobType must be garden_room, extension, or other' }
  }

  const job = await prisma.job.create({
    data: {
      title: trimmedTitle,
      jobType: resolvedJobType,
      ownerUserId: userId,
    },
    select: JOB_SELECT,
  })

  return normalizeJob(job)
}

// Statuses a user may set through PATCH. Archived is settable: it hides the
// job from the normal list but deletes nothing.
const PATCHABLE_JOB_STATUSES = new Set(['planning', 'started', 'finished', 'archived'])

// Owner-scoped job edit. Title and lightweight status are the editable fields
// in this slice — no type/delete changes; unknown body fields are ignored,
// never applied.
export async function patchJob(
  jobId: string,
  userId: string,
  patch: { title?: unknown; status?: unknown },
) {
  if (patch.title === undefined && patch.status === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'title or status is required' }
  }

  const data: { title?: string; status?: string } = {}

  if (patch.title !== undefined) {
    const trimmedTitle = typeof patch.title === 'string' ? patch.title.trim() : ''
    if (!trimmedTitle) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'title must be a non-empty string' }
    }
    if (trimmedTitle.length > MAX_JOB_TITLE_LENGTH) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'title must be 80 characters or fewer' }
    }
    data.title = trimmedTitle
  }

  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !PATCHABLE_JOB_STATUSES.has(patch.status)) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'status must be planning, started, finished, or archived' }
    }
    data.status = patch.status.toUpperCase()
  }

  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { ownerUserId: true, ...JOB_SELECT },
  })
  if (!existing) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (existing.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: data as never,
    select: JOB_SELECT,
  })
  return normalizeJob(updated)
}
