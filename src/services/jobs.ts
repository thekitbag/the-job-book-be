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

export async function getCurrentJob(userId: string) {
  const job = await prisma.job.findFirst({
    where: { ownerUserId: userId, status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
    select: JOB_SELECT,
  })

  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'No active job found' }
  return normalizeJob(job)
}

export async function listJobs(userId: string) {
  const jobs = await prisma.job.findMany({
    where: { ownerUserId: userId, status: 'ACTIVE' },
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

export async function createJob(userId: string, title: unknown, jobType: unknown) {
  const trimmedTitle = typeof title === 'string' ? title.trim() : ''
  if (!trimmedTitle) throw { code: ErrorCode.MISSING_FIELD, message: 'title is required' }
  if (trimmedTitle.length > 80) throw { code: ErrorCode.INVALID_FIELD, message: 'title must be 80 characters or fewer' }

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
