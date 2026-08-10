// Job contacts: lightweight, job-local "who is involved" context — the
// customer, building control, the electrician on this one job.
//
// Deliberately NOT a CRM: contacts are scoped to a single job, never reused or
// deduplicated across jobs, and never created from voice/extraction. They are
// manually trusted fields the pilot types and edits himself.
//
// Privacy: names, phone numbers, emails, notes, and the site address are
// personal data. Nothing in this module puts a submitted value into an error
// message, a log line, or an analytics payload — validation errors name the
// field only.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { getJob } from './jobs.js'

export const MAX_CONTACT_NAME_LENGTH = 80
export const MAX_CONTACT_ROLE_LENGTH = 60
export const MAX_CONTACT_PHONE_LENGTH = 40
export const MAX_CONTACT_EMAIL_LENGTH = 120
export const MAX_CONTACT_NOTE_LENGTH = 240
export const MAX_SITE_ADDRESS_LENGTH = 240

// Practical builder phone formats: digits with spaces, +, (), -, and dots.
// Deliberately not UK-only and deliberately not a full phone parser — it only
// rejects text that clearly is not a phone number.
const PHONE_RE = /^[0-9+()\-. ]+$/

// Lightweight email shape: one @, no whitespace, something either side. Not
// RFC validation — a builder's typo-free address should never be refused.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

interface JobContactRow {
  id: string
  jobId: string
  name: string
  role: string | null
  phone: string | null
  email: string | null
  note: string | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

const CONTACT_SELECT = {
  id: true,
  jobId: true,
  name: true,
  role: true,
  phone: true,
  email: true,
  note: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const

// Wire shape for the frontend. Soft-delete and audit columns stay internal.
function normalizeContact(contact: JobContactRow) {
  return {
    id: contact.id,
    jobId: contact.jobId,
    name: contact.name,
    role: contact.role,
    phone: contact.phone,
    email: contact.email,
    note: contact.note,
    sortOrder: contact.sortOrder,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  }
}

const invalid = (message: string) => ({ code: ErrorCode.INVALID_FIELD, message })

// Required text field: must be a present non-empty string within the cap.
function normalizeRequiredText(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`${fieldName} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw invalid(`${fieldName} must be at most ${maxLength} characters`)
  }
  return trimmed
}

// Optional text field: null clears, blank-after-trim clears, anything else must
// be a string within the cap. Callers only pass values that are present in the
// request body, so `undefined` never reaches here.
function normalizeOptionalText(value: unknown, fieldName: string, maxLength: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw invalid(`${fieldName} must be a string or null`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > maxLength) {
    throw invalid(`${fieldName} must be at most ${maxLength} characters`)
  }
  return trimmed
}

function normalizePhone(value: unknown): string | null {
  const trimmed = normalizeOptionalText(value, 'phone', MAX_CONTACT_PHONE_LENGTH)
  if (trimmed === null) return null
  if (!PHONE_RE.test(trimmed) || !/[0-9]/.test(trimmed)) {
    throw invalid('phone must be a valid phone number')
  }
  return trimmed
}

function normalizeEmail(value: unknown): string | null {
  const trimmed = normalizeOptionalText(value, 'email', MAX_CONTACT_EMAIL_LENGTH)
  if (trimmed === null) return null
  if (!EMAIL_RE.test(trimmed)) throw invalid('email must be a valid email address')
  return trimmed.toLowerCase()
}

export function normalizeSiteAddress(value: unknown): string | null {
  return normalizeOptionalText(value, 'siteAddress', MAX_SITE_ADDRESS_LENGTH)
}

// Every route in this slice goes through an owner check: a job that is not
// yours is indistinguishable from one that does not exist for reads, and a
// FORBIDDEN for writes, matching the rest of the app.
async function requireOwnedJob(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, ownerUserId: true } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

async function listContacts(jobId: string) {
  const contacts = await prisma.jobContact.findMany({
    where: { jobId, isDeleted: false },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: CONTACT_SELECT,
  })
  return contacts.map(normalizeContact)
}

// GET /api/jobs/:jobId/details — the Job details read: the job itself plus its
// live contacts. Deleted contacts and other users' data never appear here.
export async function getJobDetails(jobId: string, userId: string) {
  const job = await getJob(jobId, userId)
  return { job, contacts: await listContacts(jobId) }
}

// PATCH /api/jobs/:jobId/details — site address only in this slice. Omitted
// preserves, null or blank clears. Title/status stay on PATCH /api/jobs/:jobId.
export async function patchJobDetails(
  jobId: string,
  userId: string,
  patch: { siteAddress?: unknown },
) {
  if (patch.siteAddress === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'siteAddress is required' }
  }
  const siteAddress = normalizeSiteAddress(patch.siteAddress)

  await requireOwnedJob(jobId, userId)
  await prisma.job.update({ where: { id: jobId }, data: { siteAddress } })

  return getJobDetails(jobId, userId)
}

export interface ContactInput {
  name?: unknown
  role?: unknown
  phone?: unknown
  email?: unknown
  note?: unknown
}

// POST /api/jobs/:jobId/contacts — name is the only required field; a
// name-only contact is a perfectly good contact.
export async function createJobContact(jobId: string, userId: string, input: ContactInput) {
  if (input.name === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'name is required' }
  }
  const data = {
    name: normalizeRequiredText(input.name, 'name', MAX_CONTACT_NAME_LENGTH),
    role: input.role === undefined ? null : normalizeOptionalText(input.role, 'role', MAX_CONTACT_ROLE_LENGTH),
    phone: input.phone === undefined ? null : normalizePhone(input.phone),
    email: input.email === undefined ? null : normalizeEmail(input.email),
    note: input.note === undefined ? null : normalizeOptionalText(input.note, 'note', MAX_CONTACT_NOTE_LENGTH),
  }

  await requireOwnedJob(jobId, userId)

  // Append to the end of the job's list; removed contacts don't free up slots,
  // so ordering stays stable across removals.
  const last = await prisma.jobContact.findFirst({
    where: { jobId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })

  const contact = await prisma.jobContact.create({
    data: {
      jobId,
      createdByUserId: userId,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      ...data,
    },
    select: CONTACT_SELECT,
  })
  return normalizeContact(contact)
}

// A live contact on a job the user owns, or a 404/403 — used by patch and
// delete so a contact id from another job or another user never resolves.
async function requireOwnedContact(jobId: string, contactId: string, userId: string) {
  await requireOwnedJob(jobId, userId)
  const contact = await prisma.jobContact.findUnique({
    where: { id: contactId },
    select: { id: true, jobId: true, isDeleted: true },
  })
  if (!contact || contact.jobId !== jobId || contact.isDeleted) {
    throw { code: ErrorCode.JOB_CONTACT_NOT_FOUND, message: 'Contact not found' }
  }
  return contact
}

// PATCH /api/jobs/:jobId/contacts/:contactId — omitted fields preserve, null or
// blank clears an optional field, and name can be changed but never cleared.
export async function patchJobContact(
  jobId: string,
  contactId: string,
  userId: string,
  patch: ContactInput,
) {
  const data: Record<string, string | null> = {}
  if (patch.name !== undefined) {
    data.name = normalizeRequiredText(patch.name, 'name', MAX_CONTACT_NAME_LENGTH)
  }
  if (patch.role !== undefined) {
    data.role = normalizeOptionalText(patch.role, 'role', MAX_CONTACT_ROLE_LENGTH)
  }
  if (patch.phone !== undefined) data.phone = normalizePhone(patch.phone)
  if (patch.email !== undefined) data.email = normalizeEmail(patch.email)
  if (patch.note !== undefined) {
    data.note = normalizeOptionalText(patch.note, 'note', MAX_CONTACT_NOTE_LENGTH)
  }

  if (Object.keys(data).length === 0) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'no editable fields provided' }
  }

  await requireOwnedContact(jobId, contactId, userId)

  const updated = await prisma.jobContact.update({
    where: { id: contactId },
    data,
    select: CONTACT_SELECT,
  })
  return normalizeContact(updated)
}

// DELETE /api/jobs/:jobId/contacts/:contactId — soft delete: the row is kept
// for auditability, excluded from reads, and a repeat delete is a 404.
export async function deleteJobContact(jobId: string, contactId: string, userId: string) {
  await requireOwnedContact(jobId, contactId, userId)
  await prisma.jobContact.update({
    where: { id: contactId },
    data: { isDeleted: true, deletedAt: new Date(), deletedByUserId: userId },
  })
}
