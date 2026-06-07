import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

export async function getCurrentJob(userId: string) {
  const job = await prisma.job.findFirst({
    where: { ownerUserId: userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      jobType: true,
      status: true,
      roughLocationOrLabel: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'No active job found' }
  return job
}

export async function listJobs(userId: string) {
  return prisma.job.findMany({
    where: { ownerUserId: userId },
    select: {
      id: true,
      title: true,
      jobType: true,
      status: true,
      roughLocationOrLabel: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function getJob(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      ownerUserId: true,
      title: true,
      jobType: true,
      status: true,
      roughLocationOrLabel: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const { ownerUserId: _, ...rest } = job
  return rest
}
