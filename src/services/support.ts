// Founder Support Mode: deliberate, read-only, INTERNAL-gated cross-user
// access. Every function here resolves the target job's owner and calls the
// existing owner-scoped read services as that owner — no forked business
// logic, no support overrides on normal routes. All access is audited
// server-side; audit failure fails closed (no data without an audit row).
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import type { AudioStorageProvider } from '../storage/index.js'
import { getMemoryView } from './memory-view.js'
import { getBudgetSummary } from './budget.js'
import { getReviewQueue } from './review-queue.js'
import { listJobPhotos, getJobPhotoFile } from './photos.js'
import { getJobInspection } from './inspection.js'
import { getJobPayments } from './payments.js'

// ── Audit ─────────────────────────────────────────────────────────────────────

export const SUPPORT_AUDIT_ACTIONS = {
  usersListed: 'support_users_listed',
  userJobsViewed: 'support_user_jobs_viewed',
  jobInspected: 'support_job_inspected',
  viewAsStarted: 'support_view_as_started',
  viewAsRead: 'support_view_as_read',
  viewAsExited: 'support_view_as_exited',
} as const

// A view-as "session" for started-vs-read purposes: reads within this window
// of the last view-as event on the same admin+job are follow-up reads.
const VIEW_AS_SESSION_WINDOW_MS = 30 * 60 * 1000

interface AuditInput {
  adminUserId: string
  action: string
  targetUserId?: string | null
  targetJobId?: string | null
  metadata?: Record<string, string> | null
}

// Awaited by every support read: if the audit row cannot be written, the
// access fails closed. Metadata is small and never contains secrets or
// storage keys.
async function writeAudit(input: AuditInput) {
  await prisma.supportAuditEvent.create({
    data: {
      adminUserId: input.adminUserId,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetJobId: input.targetJobId ?? null,
      metadata: input.metadata ?? undefined,
    },
  })
}

// First workspace read for an admin+job in the session window is a
// "view-as started"; later reads are "view-as read" rows.
async function auditViewAsRead(adminUserId: string, targetUserId: string, targetJobId: string, route: string) {
  const recent = await prisma.supportAuditEvent.findFirst({
    where: {
      adminUserId,
      targetJobId,
      action: { in: [SUPPORT_AUDIT_ACTIONS.viewAsStarted, SUPPORT_AUDIT_ACTIONS.viewAsRead] },
      createdAt: { gte: new Date(Date.now() - VIEW_AS_SESSION_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  })
  await writeAudit({
    adminUserId,
    action: recent ? SUPPORT_AUDIT_ACTIONS.viewAsRead : SUPPORT_AUDIT_ACTIONS.viewAsStarted,
    targetUserId,
    targetJobId,
    metadata: { route },
  })
}

// ── Target resolution ─────────────────────────────────────────────────────────

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const

// Explicit field pick on top of the Prisma select: support responses must
// never serialize password hashes or auth metadata even if a query is later
// widened, so the allow-list is enforced here too.
function toSafeUser(user: { id: string; email: string; name: string | null; role: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

async function requireTargetUser(targetUserId: string) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: SAFE_USER_SELECT })
  if (!user) throw { code: ErrorCode.USER_NOT_FOUND, message: 'User not found' }
  return toSafeUser(user)
}

// Unknown jobs are 404 — support routes never reveal whether a job exists in
// some other shape.
async function requireTargetJob(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  return job
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function listSupportUsers(adminUserId: string) {
  const [users, jobs, noteActivity] = await Promise.all([
    prisma.user.findMany({ select: SAFE_USER_SELECT, orderBy: { email: 'asc' } }),
    prisma.job.findMany({ select: { id: true, ownerUserId: true, updatedAt: true } }),
    prisma.rawNote.groupBy({ by: ['jobId'], _max: { uploadedAt: true } }),
  ])

  const latestNoteByJob = new Map(noteActivity.map((n) => [n.jobId, n._max.uploadedAt]))
  const jobCounts = new Map<string, number>()
  const lastActivity = new Map<string, Date>()
  for (const job of jobs) {
    jobCounts.set(job.ownerUserId, (jobCounts.get(job.ownerUserId) ?? 0) + 1)
    const candidates = [job.updatedAt, latestNoteByJob.get(job.id) ?? null]
    for (const t of candidates) {
      if (!t) continue
      const current = lastActivity.get(job.ownerUserId)
      if (!current || t > current) lastActivity.set(job.ownerUserId, t)
    }
  }

  const supportUsers = users
    .map((u) => ({
      ...toSafeUser(u),
      jobCount: jobCounts.get(u.id) ?? 0,
      lastActivityAt: lastActivity.get(u.id) ?? null,
    }))
    .sort((a, b) => {
      const at = a.lastActivityAt?.getTime() ?? 0
      const bt = b.lastActivityAt?.getTime() ?? 0
      if (at !== bt) return bt - at
      return a.email.localeCompare(b.email)
    })

  await writeAudit({ adminUserId, action: SUPPORT_AUDIT_ACTIONS.usersListed })
  return { users: supportUsers }
}

// ── Jobs for a target user ────────────────────────────────────────────────────

export async function listSupportUserJobs(adminUserId: string, targetUserId: string) {
  const user = await requireTargetUser(targetUserId)

  const [jobs, unresolvedFacts] = await Promise.all([
    prisma.job.findMany({
      where: { ownerUserId: targetUserId },
      include: { _count: { select: { rawNotes: true, memoryItems: true, photos: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
    // "Review items" = unresolved candidate facts awaiting review.
    prisma.candidateFact.findMany({
      where: { job: { ownerUserId: targetUserId }, status: { in: ['DRAFT', 'UNCLEAR'] } },
      select: { jobId: true },
    }),
  ])

  const reviewCounts = new Map<string, number>()
  for (const f of unresolvedFacts) reviewCounts.set(f.jobId, (reviewCounts.get(f.jobId) ?? 0) + 1)

  await writeAudit({ adminUserId, action: SUPPORT_AUDIT_ACTIONS.userJobsViewed, targetUserId })

  return {
    user: { ...user, jobCount: jobs.length, lastActivityAt: jobs[0]?.updatedAt ?? null },
    jobs: jobs.map((j) => ({
      id: j.id,
      ownerUserId: j.ownerUserId,
      title: j.title,
      jobType: j.jobType,
      status: j.status.toLowerCase(),
      roughLocationOrLabel: j.roughLocationOrLabel,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      counts: {
        notes: j._count.rawNotes,
        memoryItems: j._count.memoryItems,
        reviewItems: reviewCounts.get(j.id) ?? 0,
        photos: j._count.photos,
      },
    })),
  }
}

// Photos rendered in support mode must be loadable by the internal user, so
// support responses point imageUrl at the support-authenticated file route
// (the normal user route would 403 for the founder).
function toSupportPhoto<T extends { id: string }>(jobId: string, photo: T): T {
  return { ...photo, imageUrl: `/api/internal/support/jobs/${jobId}/photos/${photo.id}/file` }
}

// ── Job inspection ────────────────────────────────────────────────────────────

// The active internal inspection surface: the existing inspection assembly run
// as the owner, extended with the owner summary and photo metadata.
export async function getSupportJobInspection(adminUserId: string, jobId: string) {
  const job = await requireTargetJob(jobId)
  const owner = await requireTargetUser(job.ownerUserId)

  // Deliberate access: audit first so a failed audit blocks the read.
  await writeAudit({
    adminUserId,
    action: SUPPORT_AUDIT_ACTIONS.jobInspected,
    targetUserId: owner.id,
    targetJobId: jobId,
  })

  const [inspection, photos] = await Promise.all([
    getJobInspection(jobId, owner.id),
    listJobPhotos(jobId, owner.id),
  ])

  return { owner, ...inspection, photos: photos.photos.map((p) => toSupportPhoto(jobId, p)) }
}

// ── Read-only view-as-user workspace reads ────────────────────────────────────
//
// Each helper resolves the job → owner, audits, then calls the normal
// user-facing read service as the owner, so support responses are exactly the
// shapes the pilot's own workspace consumes.

async function resolveAndAudit(adminUserId: string, jobId: string, route: string) {
  const job = await requireTargetJob(jobId)
  await auditViewAsRead(adminUserId, job.ownerUserId, jobId, route)
  return job
}

export async function getSupportMemoryView(adminUserId: string, jobId: string) {
  const job = await resolveAndAudit(adminUserId, jobId, 'memory-view')
  return getMemoryView(jobId, job.ownerUserId)
}

export async function getSupportBudgetSummary(adminUserId: string, jobId: string) {
  const job = await resolveAndAudit(adminUserId, jobId, 'budget-summary')
  return getBudgetSummary(jobId, job.ownerUserId)
}

export async function getSupportReviewQueue(adminUserId: string, jobId: string) {
  const job = await resolveAndAudit(adminUserId, jobId, 'review-queue')
  return getReviewQueue(jobId, job.ownerUserId)
}

export async function getSupportJobPhotos(adminUserId: string, jobId: string) {
  const job = await resolveAndAudit(adminUserId, jobId, 'photos')
  const result = await listJobPhotos(jobId, job.ownerUserId)
  return { ...result, photos: result.photos.map((p) => toSupportPhoto(jobId, p)) }
}

export async function getSupportJobPayments(adminUserId: string, jobId: string) {
  const job = await resolveAndAudit(adminUserId, jobId, 'payments')
  return getJobPayments(jobId, job.ownerUserId)
}

export async function getSupportJobPhotoFile(
  adminUserId: string,
  jobId: string,
  photoId: string,
  storage: AudioStorageProvider,
) {
  const job = await resolveAndAudit(adminUserId, jobId, 'photo-file')
  return getJobPhotoFile(jobId, photoId, job.ownerUserId, storage)
}
