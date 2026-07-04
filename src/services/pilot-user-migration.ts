// Converts the existing live pilot user row into a real email/password account,
// preserving the user id so jobs.ownerUserId / review_decisions.decidedBy links
// are untouched. All reusable logic lives here; src/scripts/migrate-pilot-user.ts
// is the CLI entry point.
import type { PrismaClient } from '@prisma/client'
import { hashPassword } from '../lib/password.js'

export interface MigrationOptions {
  dryRun: boolean
  pilotUserId: string
  email: string
  name?: string
  // If omitted, no password is set and Mike uses the password-reset flow.
  tempPassword?: string
}

export interface TableCounts {
  jobs: number
  rawNotes: number
  audioObjects: number
  transcripts: number
  candidateFacts: number
  queueItems: number
  reviewDecisions: number
  memoryItems: number
  jobBudgetCategories: number
}

export interface MigrationResult {
  dryRun: boolean
  pilotUser: { id: string; email: string; name: string; role: string; hasPassword: boolean }
  plannedChanges: {
    newEmail: string
    newName: string | null
    willSetPassword: boolean
  }
  totalUsers: number
  countsBefore: TableCounts
  countsAfter: TableCounts | null
  verified: boolean
}

async function countUserData(prisma: PrismaClient, userId: string): Promise<TableCounts> {
  const jobWhere = { job: { ownerUserId: userId } }
  const [jobs, rawNotes, audioObjects, transcripts, candidateFacts, queueItems, reviewDecisions, memoryItems, jobBudgetCategories] =
    await Promise.all([
      prisma.job.count({ where: { ownerUserId: userId } }),
      prisma.rawNote.count({ where: jobWhere }),
      prisma.audioObject.count({ where: { note: jobWhere } }),
      prisma.transcript.count({ where: { note: jobWhere } }),
      prisma.candidateFact.count({ where: jobWhere }),
      prisma.queueItem.count({ where: jobWhere }),
      prisma.reviewDecision.count({ where: jobWhere }),
      prisma.memoryItem.count({ where: jobWhere }),
      prisma.jobBudgetCategory.count({ where: jobWhere }),
    ])
  return { jobs, rawNotes, audioObjects, transcripts, candidateFacts, queueItems, reviewDecisions, memoryItems, jobBudgetCategories }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function runPilotUserMigration(
  opts: MigrationOptions,
  deps: { prisma: PrismaClient },
): Promise<MigrationResult> {
  const { prisma } = deps
  const email = normalizeEmail(opts.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Target email "${email}" does not look like a valid email address`)
  }

  // Identify exactly one pilot user by explicit id — never a broad update.
  const pilotUser = await prisma.user.findUnique({ where: { id: opts.pilotUserId } })
  if (!pilotUser) {
    throw new Error(`Pilot user ${opts.pilotUserId} not found — refusing to continue`)
  }

  // Refuse if the target email already belongs to a different user.
  const emailOwner = await prisma.user.findUnique({ where: { email } })
  if (emailOwner && emailOwner.id !== pilotUser.id) {
    throw new Error(
      `Target email ${email} already belongs to a different user (${emailOwner.id}) — refusing to continue`,
    )
  }

  const totalUsers = await prisma.user.count()
  const countsBefore = await countUserData(prisma, pilotUser.id)

  const result: MigrationResult = {
    dryRun: opts.dryRun,
    pilotUser: {
      id: pilotUser.id,
      email: pilotUser.email,
      name: pilotUser.name,
      role: pilotUser.role,
      hasPassword: pilotUser.passwordHash !== null,
    },
    plannedChanges: {
      newEmail: email,
      newName: opts.name?.trim() || null,
      willSetPassword: Boolean(opts.tempPassword),
    },
    totalUsers,
    countsBefore,
    countsAfter: null,
    verified: false,
  }

  if (opts.dryRun) return result

  const passwordHash = opts.tempPassword ? await hashPassword(opts.tempPassword) : undefined

  // Single-row update keyed by id — cannot touch any other user's rows.
  await prisma.user.update({
    where: { id: pilotUser.id },
    data: {
      email,
      ...(result.plannedChanges.newName ? { name: result.plannedChanges.newName } : {}),
      ...(passwordHash ? { passwordHash } : {}),
    },
  })

  // Post-write verification: user row converted, child data counts unchanged.
  const updated = await prisma.user.findUnique({ where: { id: pilotUser.id } })
  const countsAfter = await countUserData(prisma, pilotUser.id)
  result.countsAfter = countsAfter
  result.verified =
    updated !== null &&
    updated.email === email &&
    (!opts.tempPassword || updated.passwordHash !== null) &&
    (Object.keys(countsBefore) as Array<keyof TableCounts>).every(
      (k) => countsBefore[k] === countsAfter[k],
    )

  if (!result.verified) {
    throw new Error(
      'Post-migration verification FAILED — user row or data counts do not match expectations. ' +
        'Investigate immediately; consider restoring from backup.',
    )
  }

  return result
}
