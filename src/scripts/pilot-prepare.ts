/**
 * pilot:prepare — pilot clean-starting-state script
 *
 * Usage:
 *   npm run pilot:prepare -- --dry-run --mode empty
 *   npm run pilot:prepare -- --dry-run --mode create-job --title "Poole garden room" --job-type garden_room
 *   npm run pilot:prepare -- --execute --mode empty
 *   npm run pilot:prepare -- --execute --mode create-job --title "Poole garden room" --job-type garden_room
 *
 * --dry-run is the default. --execute is required to write any data.
 * Production execution requires NODE_ENV=production.
 */

import type { PrismaClient } from '@prisma/client'
import { ALLOWED_JOB_TYPES } from '../services/jobs.js'

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

  // Validate pilot user
  const pilotUser = await prisma.user.findUnique({ where: { id: pilotUserId } })
  if (!pilotUser) {
    throw new Error(`Pilot user not found: PILOT_USER_ID=${pilotUserId}`)
  }

  // Validate create-job args early
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

  // Collect all jobs for pilot user
  const jobs = await prisma.job.findMany({
    where: { ownerUserId: pilotUserId },
    select: { id: true, title: true, status: true },
  })

  const jobIds = jobs.map((j) => j.id)

  // Collect raw notes for those jobs
  const notes = jobIds.length > 0
    ? await prisma.rawNote.findMany({
        where: { jobId: { in: jobIds } },
        select: { id: true },
      })
    : []
  const noteIds = notes.map((n) => n.id)

  // Collect audio objects (for R2 cleanup)
  const audioObjects = noteIds.length > 0
    ? await prisma.audioObject.findMany({
        where: { noteId: { in: noteIds } },
        select: { id: true, storageKey: true, noteId: true },
      })
    : []

  // Collect downstream counts
  const transcriptCount = noteIds.length > 0
    ? await prisma.transcript.count({ where: { noteId: { in: noteIds } } })
    : 0

  const candidateFactCount = jobIds.length > 0
    ? await prisma.candidateFact.count({ where: { jobId: { in: jobIds } } })
    : 0

  const queueItemCount = jobIds.length > 0
    ? await prisma.queueItem.count({ where: { jobId: { in: jobIds } } })
    : 0

  const reviewDecisionCount = jobIds.length > 0
    ? await prisma.reviewDecision.count({ where: { jobId: { in: jobIds } } })
    : 0

  const memoryItemCount = jobIds.length > 0
    ? await prisma.memoryItem.count({ where: { jobId: { in: jobIds } } })
    : 0

  const counts = {
    jobs: jobs.length,
    notes: notes.length,
    audioObjects: audioObjects.length,
    transcripts: transcriptCount,
    candidateFacts: candidateFactCount,
    queueItems: queueItemCount,
    reviewDecisions: reviewDecisionCount,
    memoryItems: memoryItemCount,
  }

  const r2StorageKeys = audioObjects.map((a) => a.storageKey)
  const r2Failures: string[] = []

  const result: PrepareResult = {
    pilotUserId,
    pilotUserEmail: pilotUser.email,
    dryRun,
    jobsToClean: jobs.map((j) => ({ id: j.id, title: j.title, status: j.status })),
    counts,
    r2StorageKeys,
    r2Failures,
  }

  if (dryRun) return result

  // ── Execute ────────────────────────────────────────────────────────────────

  // 1. Delete R2 objects first (before DB rows)
  if (deleteFromR2) {
    for (const key of r2StorageKeys) {
      try {
        await deleteFromR2(key)
      } catch (err) {
        r2Failures.push(key)
      }
    }
  }

  // 2. Delete DB rows in dependency-safe order (leaf → root)
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

  // 3. Create new job if requested
  if (mode === 'create-job' && title) {
    const resolvedJobType = jobType ?? 'other'
    const newJob = await prisma.job.create({
      data: {
        title: title.trim(),
        jobType: resolvedJobType,
        ownerUserId: pilotUserId,
      },
      select: { id: true, title: true, jobType: true },
    })
    result.createdJob = { id: newJob.id, title: newJob.title, jobType: newJob.jobType }
  }

  return result
}

// ── CLI entry point ────────────────────────────────────────────────────────────

function printResult(result: PrepareResult): void {
  const label = result.dryRun ? '[DRY-RUN]' : '[EXECUTED]'
  console.log(`\n${label} Pilot prepare — mode completed`)
  console.log(`  Pilot user: ${result.pilotUserId} (${result.pilotUserEmail})`)
  console.log(`  Dry-run: ${result.dryRun}`)
  console.log('\n  Jobs that will be / were cleaned:')
  if (result.jobsToClean.length === 0) {
    console.log('    (none — pilot user has no jobs)')
  } else {
    for (const j of result.jobsToClean) {
      console.log(`    - [${j.status}] ${j.title} (${j.id})`)
    }
  }
  console.log('\n  Downstream counts:')
  const c = result.counts
  console.log(`    jobs:            ${c.jobs}`)
  console.log(`    notes:           ${c.notes}`)
  console.log(`    audio objects:   ${c.audioObjects}`)
  console.log(`    transcripts:     ${c.transcripts}`)
  console.log(`    candidate facts: ${c.candidateFacts}`)
  console.log(`    queue items:     ${c.queueItems}`)
  console.log(`    review decisions:${c.reviewDecisions}`)
  console.log(`    memory items:    ${c.memoryItems}`)
  if (result.r2StorageKeys.length > 0) {
    console.log('\n  R2 storage keys:')
    for (const key of result.r2StorageKeys) {
      console.log(`    - ${key}`)
    }
  }
  if (result.r2Failures.length > 0) {
    console.log('\n  R2 DELETION FAILURES (manual cleanup required):')
    for (const key of result.r2Failures) {
      console.log(`    - FAILED: ${key}`)
    }
  }
  if (result.createdJob) {
    console.log(`\n  Created job: "${result.createdJob.title}" (${result.createdJob.id})`)
  }
  console.log()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const hasExecute = args.includes('--execute')
  const hasDryRun = args.includes('--dry-run')
  const dryRun = !hasExecute || hasDryRun

  const modeIdx = args.indexOf('--mode')
  const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'empty'
  if (mode !== 'empty' && mode !== 'create-job') {
    console.error(`Error: --mode must be empty or create-job (got "${mode}")`)
    process.exit(1)
  }

  const titleIdx = args.indexOf('--title')
  const title = titleIdx !== -1 ? args[titleIdx + 1] : undefined

  const jobTypeIdx = args.indexOf('--job-type')
  const jobType = jobTypeIdx !== -1 ? args[jobTypeIdx + 1] : 'other'

  const pilotUserId = process.env.PILOT_USER_ID
  if (!pilotUserId) {
    console.error('Error: PILOT_USER_ID environment variable is not set')
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n[DRY-RUN] No data will be changed. Pass --execute to apply changes.')
  } else {
    console.log('\n[EXECUTE] Data will be permanently deleted.')
  }

  const { prisma } = await import('../db/client.js')

  let deleteFromR2: ((key: string) => Promise<void>) | undefined
  if (!dryRun) {
    const { R2AudioStorage } = await import('../storage/r2.js')
    const endpoint = process.env.R2_ENDPOINT
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    const bucket = process.env.R2_BUCKET
    if (endpoint && accessKeyId && secretAccessKey && bucket) {
      const r2 = new R2AudioStorage({ endpoint, accessKeyId, secretAccessKey, bucket })
      deleteFromR2 = (key) => r2.delete(key)
    } else {
      console.warn('Warning: R2 env vars not set — audio objects will be deleted from DB only. Orphaned R2 objects require manual cleanup.')
    }
  }

  try {
    const result = await runPilotPrepare(
      { dryRun, mode, title, jobType, pilotUserId },
      { prisma, deleteFromR2 },
    )
    printResult(result)
    if (result.r2Failures.length > 0) {
      console.error('Warning: some R2 deletions failed. DB rows were still deleted. Orphaned audio objects require manual R2 cleanup.')
      process.exit(2)
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
