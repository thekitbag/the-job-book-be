import type { PrismaClient } from '@prisma/client'
import { ALLOWED_JOB_TYPES } from './jobs.js'

export interface PrepareOptions {
  dryRun: boolean
  mode: 'empty' | 'create-job'
  title?: string
  jobType?: string
  pilotUserId: string
}

export interface PrepareResult {
  pilotUserId: string
  pilotUserEmail: string
  dryRun: boolean
  jobsToClean: Array<{ id: string; title: string; status: string }>
  counts: {
    jobs: number
    notes: number
    audioObjects: number
    transcripts: number
    candidateFacts: number
    queueItems: number
    reviewDecisions: number
    memoryItems: number
  }
  r2StorageKeys: string[]
  r2Failures: string[]
  createdJob?: { id: string; title: string; jobType: string }
}

export async function runPilotPrepare(
  options: PrepareOptions,
  deps: {
    prisma: PrismaClient
    deleteFromR2?: (key: string) => Promise<void>
  },
): Promise<PrepareResult> {
  const { dryRun, mode, title, jobType, pilotUserId } = options
  const { prisma, deleteFromR2 } = deps

  const pilotUser = await prisma.user.findUnique({ where: { id: pilotUserId } })
  if (!pilotUser) {
    throw new Error(`Pilot user not found: PILOT_USER_ID=${pilotUserId}`)
  }

  if (mode === 'create-job') {
    if (!title || !title.trim()) {
      throw new Error('--title is required for create-job mode')
    }
    const resolvedJobType = jobType ?? 'other'
    if (!ALLOWED_JOB_TYPES.has(resolvedJobType)) {
      throw new Error(
        `--job-type must be one of: ${[...ALLOWED_JOB_TYPES].join(', ')} (got "${resolvedJobType}")`,
      )
    }
  }

  const jobs = await prisma.job.findMany({
    where: { ownerUserId: pilotUserId },
    select: { id: true, title: true, status: true },
  })
  const jobIds = jobs.map((j) => j.id)

  const notes = jobIds.length > 0
    ? await prisma.rawNote.findMany({ where: { jobId: { in: jobIds } }, select: { id: true } })
    : []
  const noteIds = notes.map((n) => n.id)

  const audioObjects = noteIds.length > 0
    ? await prisma.audioObject.findMany({
        where: { noteId: { in: noteIds } },
        select: { id: true, storageKey: true, noteId: true },
      })
    : []

  const transcriptCount = noteIds.length > 0
    ? await prisma.transcript.count({ where: { noteId: { in: noteIds } } }) : 0
  const candidateFactCount = jobIds.length > 0
    ? await prisma.candidateFact.count({ where: { jobId: { in: jobIds } } }) : 0
  const queueItemCount = jobIds.length > 0
    ? await prisma.queueItem.count({ where: { jobId: { in: jobIds } } }) : 0
  const reviewDecisionCount = jobIds.length > 0
    ? await prisma.reviewDecision.count({ where: { jobId: { in: jobIds } } }) : 0
  const memoryItemCount = jobIds.length > 0
    ? await prisma.memoryItem.count({ where: { jobId: { in: jobIds } } }) : 0

  const r2StorageKeys = audioObjects.map((a) => a.storageKey)
  const r2Failures: string[] = []

  const result: PrepareResult = {
    pilotUserId,
    pilotUserEmail: pilotUser.email,
    dryRun,
    jobsToClean: jobs.map((j) => ({ id: j.id, title: j.title, status: j.status })),
    counts: {
      jobs: jobs.length,
      notes: notes.length,
      audioObjects: audioObjects.length,
      transcripts: transcriptCount,
      candidateFacts: candidateFactCount,
      queueItems: queueItemCount,
      reviewDecisions: reviewDecisionCount,
      memoryItems: memoryItemCount,
    },
    r2StorageKeys,
    r2Failures,
  }

  if (dryRun) return result

  // Delete R2 objects first (before DB rows); DB cleanup continues regardless of R2 failures.
  // On non-zero exit (r2Failures.length > 0) the operator must manually clean listed keys from R2.
  if (deleteFromR2) {
    for (const key of r2StorageKeys) {
      try {
        await deleteFromR2(key)
      } catch {
        r2Failures.push(key)
      }
    }
  }

  if (jobIds.length > 0) {
    await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
    if (noteIds.length > 0) {
      await prisma.transcript.deleteMany({ where: { noteId: { in: noteIds } } })
      await prisma.audioObject.deleteMany({ where: { noteId: { in: noteIds } } })
    }
    await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  }

  if (mode === 'create-job' && title) {
    const resolvedJobType = jobType ?? 'other'
    const newJob = await prisma.job.create({
      data: { title: title.trim(), jobType: resolvedJobType, ownerUserId: pilotUserId },
      select: { id: true, title: true, jobType: true },
    })
    result.createdJob = { id: newJob.id, title: newJob.title, jobType: newJob.jobType }
  }

  return result
}
