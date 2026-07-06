/**
 * migrate:pilot-user — convert the live pilot user row into Mike's real
 * email/password account, preserving the user id (jobs.ownerUserId and
 * review_decisions.decidedBy keep pointing at the same row).
 *
 * This file is a CLI entry point only. Reusable logic lives in
 * src/services/pilot-user-migration.ts; import from there in tests.
 *
 * Usage:
 *   npm run migrate:pilot-user -- \
 *     --target production \
 *     --expect-db-host <host-substring-of-DATABASE_URL> \
 *     --user-id <pilot user uuid> \
 *     --email mike@example.com \
 *     [--name "Mike"] \
 *     [--temp-password <temporary password>] \
 *     [--execute]
 *
 * Safety rails:
 *   - dry-run is the default; --execute is required to write
 *   - --target is required and must be one of production|staging|test
 *   - --expect-db-host must match the host of DATABASE_URL, so the script
 *     cannot silently run against the wrong database
 *   - DATABASE_URL is read from the process environment at start; this script
 *     deliberately does NOT load any dotenv file
 *   - the pilot user is identified by explicit --user-id (or PILOT_USER_ID);
 *     the write is a single-row update keyed by that id
 *   - refuses to run if the target email already belongs to another user
 *   - after --execute it verifies the converted row and that all child-data
 *     counts are unchanged, and exits non-zero if verification fails
 *
 * If --temp-password is omitted, no password is set and Mike signs in via the
 * password-reset flow (recommended: no shared secret in the terminal).
 */

import { PrismaClient } from '@prisma/client'
import { runPilotUserMigration } from '../services/pilot-user-migration.js'
import type { MigrationResult, TableCounts } from '../services/pilot-user-migration.js'

const VALID_TARGETS = new Set(['production', 'staging', 'test'])

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const val = args[idx + 1]
  if (!val || val.startsWith('--')) {
    console.error(`Error: ${flag} requires a value`)
    process.exit(1)
  }
  return val
}

function printCounts(label: string, c: TableCounts): void {
  console.log(`\n  ${label}:`)
  console.log(`    jobs:                  ${c.jobs}`)
  console.log(`    raw_notes:             ${c.rawNotes}`)
  console.log(`    audio_objects:         ${c.audioObjects}`)
  console.log(`    transcripts:           ${c.transcripts}`)
  console.log(`    candidate_facts:       ${c.candidateFacts}`)
  console.log(`    queue_items:           ${c.queueItems}`)
  console.log(`    review_decisions:      ${c.reviewDecisions}`)
  console.log(`    memory_items:          ${c.memoryItems}`)
  console.log(`    job_budget_categories: ${c.jobBudgetCategories}`)
}

function printResult(result: MigrationResult): void {
  const label = result.dryRun ? '[DRY-RUN]' : '[EXECUTED]'
  console.log(`\n${label} Pilot user migration`)
  console.log(`  Pilot user:   ${result.pilotUser.id}`)
  console.log(`  Current:      email=${result.pilotUser.email} name=${result.pilotUser.name} role=${result.pilotUser.role} hasPassword=${result.pilotUser.hasPassword}`)
  console.log(`  Planned:      email=${result.plannedChanges.newEmail}` +
    (result.plannedChanges.newName ? ` name=${result.plannedChanges.newName}` : ' (name unchanged)') +
    (result.plannedChanges.willSetPassword ? ' + set temporary password' : ' (no password set — reset flow)'))
  console.log(`  Total users in database: ${result.totalUsers} (only the pilot user row above will be written)`)
  printCounts('Child-data counts (before)', result.countsBefore)
  if (result.countsAfter) {
    printCounts('Child-data counts (after)', result.countsAfter)
    console.log(`\n  Post-migration verification: ${result.verified ? 'PASSED' : 'FAILED'}`)
  }
  console.log()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const dryRun = !args.includes('--execute')

  const target = argValue(args, '--target')
  if (!target || !VALID_TARGETS.has(target)) {
    console.error('Error: --target is required and must be one of: production, staging, test')
    process.exit(1)
  }

  const expectDbHost = argValue(args, '--expect-db-host')
  if (!expectDbHost) {
    console.error('Error: --expect-db-host is required (a substring of the DATABASE_URL host)')
    process.exit(1)
  }

  // DATABASE_URL comes from the process environment at start — no dotenv here.
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('Error: DATABASE_URL is not set in the process environment')
    process.exit(1)
  }
  let dbHost: string
  try {
    dbHost = new URL(dbUrl).hostname
  } catch {
    console.error('Error: DATABASE_URL is not a parseable URL')
    process.exit(1)
    return
  }
  if (!dbHost.includes(expectDbHost)) {
    console.error(`Error: DATABASE_URL host "${dbHost}" does not match --expect-db-host "${expectDbHost}" — refusing to run`)
    process.exit(1)
  }
  if (target === 'production' && /localhost|127\.0\.0\.1/.test(dbHost)) {
    console.error('Error: --target production but DATABASE_URL points at localhost — refusing to run')
    process.exit(1)
  }

  const pilotUserId = argValue(args, '--user-id') ?? process.env.PILOT_USER_ID
  if (!pilotUserId) {
    console.error('Error: pass --user-id <uuid> or set PILOT_USER_ID')
    process.exit(1)
  }

  const email = argValue(args, '--email')
  if (!email) {
    console.error('Error: --email is required (Mike\'s confirmed email address)')
    process.exit(1)
  }

  const name = argValue(args, '--name')
  const tempPassword = argValue(args, '--temp-password')

  console.log(`\nTarget: ${target}  DB host: ${dbHost}`)
  console.log(
    dryRun
      ? '[DRY-RUN] No data will be changed. Pass --execute to apply changes.'
      : '[EXECUTE] The pilot user row will be converted.',
  )

  const prisma = new PrismaClient()
  try {
    const result = await runPilotUserMigration(
      { dryRun, pilotUserId, email, name, tempPassword },
      { prisma },
    )
    printResult(result)
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
