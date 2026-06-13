/**
 * pilot:prepare — pilot clean-starting-state CLI
 *
 * This file is a CLI entry point only. All reusable logic lives in
 * src/services/pilot-prepare.ts; import from there in tests.
 *
 * Usage:
 *   npm run pilot:prepare -- --dry-run --mode empty
 *   npm run pilot:prepare -- --dry-run --mode create-job --title "Poole garden room" --job-type garden_room
 *   npm run pilot:prepare -- --execute --mode empty
 *   npm run pilot:prepare -- --execute --mode create-job --title "Poole garden room" --job-type garden_room
 *
 * --dry-run is the default. --execute is required to write any data.
 *
 * R2 behaviour on --execute:
 *   - R2 objects are deleted before DB rows when R2 env vars are set.
 *   - If R2 deletion fails for any key, DB cleanup still completes and the
 *     script exits with code 2. The operator must manually delete the listed
 *     keys from R2 — they will not appear in the app but remain in the bucket.
 *   - If R2 env vars are absent, DB rows are removed and audio objects remain
 *     as orphaned R2 objects; listed keys in dry-run output are the cleanup debt.
 */

import { runPilotPrepare } from '../services/pilot-prepare.js'
import type { PrepareResult } from '../services/pilot-prepare.js'

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
    console.log('\n  R2 DELETION FAILURES — operator must manually delete these keys from R2:')
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

  console.log(
    dryRun
      ? '\n[DRY-RUN] No data will be changed. Pass --execute to apply changes.'
      : '\n[EXECUTE] Data will be permanently deleted.',
  )

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
      console.warn(
        'Warning: R2 env vars not set — audio objects will be deleted from DB only.\n' +
        'Orphaned R2 objects (listed above as storage keys) require manual cleanup.',
      )
    }
  }

  try {
    const result = await runPilotPrepare(
      { dryRun, mode, title, jobType, pilotUserId },
      { prisma, deleteFromR2 },
    )
    printResult(result)
    if (result.r2Failures.length > 0) {
      console.error(
        'Warning: R2 deletions failed (see above). DB rows were deleted. ' +
        'Operator must manually remove the listed keys from R2 and record this action.',
      )
      process.exit(2)
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
