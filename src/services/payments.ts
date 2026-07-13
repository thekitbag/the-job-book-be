// Customer payments: money-in memory for a job. Deliberately separate from
// spend/budget/labour — nothing here is read by the money-out summaries, and
// nothing here reads them. GBP only in this slice.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { strictParsePositive } from '../lib/cost-utils.js'
import { ukLocalNoon } from '../lib/dates.js'

export const MAX_PAYMENT_NOTE_LENGTH = 120
export const MAX_PAYMENT_REFERENCE_LENGTH = 80

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

// ── Field validation ──────────────────────────────────────────────────────────

function parseAmount(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || strictParsePositive(value) === null) {
    throw { code: ErrorCode.INVALID_FIELD, message: `${fieldName} must be a positive decimal string` }
  }
  return value
}

function assertGbp(value: unknown, fieldName: string) {
  if (value !== undefined && value !== null && value !== 'GBP') {
    throw { code: ErrorCode.INVALID_FIELD, message: `${fieldName} must be GBP` }
  }
}

// paidAt: full ISO datetime, or YYYY-MM-DD stored as UK local noon (matching
// the existing date-only handling for happenedAt).
function parsePaidAt(value: unknown): Date {
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ukLocalNoon(trimmed)
    const d = new Date(trimmed)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw { code: ErrorCode.INVALID_FIELD, message: 'paidAt must be an ISO date/time or YYYY-MM-DD' }
}

// Trimmed optional text: blank becomes null, over-length rejected.
function parseOptionalText(value: unknown, fieldName: string, maxLength: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') {
    throw { code: ErrorCode.INVALID_FIELD, message: `${fieldName} must be a string or null` }
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > maxLength) {
    throw { code: ErrorCode.INVALID_FIELD, message: `${fieldName} must be at most ${maxLength} characters` }
  }
  return trimmed
}

// ── Wire shapes ───────────────────────────────────────────────────────────────

const gbp = (amount: string) => `£${amount}`
const round2 = (n: number) => String(Math.round(n * 100) / 100)

function normalizePayment(p: {
  id: string
  jobId: string
  amount: string
  currency: string
  paidAt: Date
  note: string | null
  reference: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: p.id,
    jobId: p.jobId,
    amount: p.amount,
    currency: p.currency,
    amountLabel: gbp(p.amount),
    paidAt: p.paidAt,
    note: p.note,
    reference: p.reference,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

// The payment summary: customer total (may be null), total paid across active
// payments, still owed when the total is known (floored at 0), and an explicit
// overpaid state when paid exceeds the total.
async function buildPaymentsSummary(job: {
  id: string
  customerTotalAmount: string | null
  customerTotalCurrency: string | null
}) {
  const payments = await prisma.jobPayment.findMany({
    where: { jobId: job.id, isDeleted: false },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
  })

  const paidNum = payments.reduce((sum, p) => sum + (strictParsePositive(p.amount) ?? 0), 0)
  const totalPaidAmount = payments.length > 0 ? round2(paidNum) : null

  const customerTotalAmount = job.customerTotalAmount
  const totalNum = strictParsePositive(customerTotalAmount)

  let stillOwedAmount: string | null = null
  let overpaid = false
  let overpaidAmount: string | null = null
  if (totalNum !== null) {
    const owed = totalNum - paidNum
    if (owed >= 0) {
      stillOwedAmount = round2(owed)
    } else {
      stillOwedAmount = '0'
      overpaid = true
      overpaidAmount = round2(-owed)
    }
  }

  return {
    jobId: job.id,
    generatedAt: new Date().toISOString(),
    customerTotalAmount,
    customerTotalCurrency: customerTotalAmount !== null ? 'GBP' : null,
    customerTotalLabel: customerTotalAmount !== null ? gbp(customerTotalAmount) : null,
    totalPaidAmount,
    totalPaidCurrency: totalPaidAmount !== null ? 'GBP' : null,
    totalPaidLabel: totalPaidAmount !== null ? `${gbp(totalPaidAmount)} paid` : null,
    stillOwedAmount,
    stillOwedCurrency: stillOwedAmount !== null ? 'GBP' : null,
    stillOwedLabel: stillOwedAmount !== null ? `${gbp(stillOwedAmount)} still owed` : null,
    overpaid,
    overpaidAmount,
    overpaidLabel: overpaidAmount !== null ? `${gbp(overpaidAmount)} overpaid` : null,
    payments: payments.map(normalizePayment),
  }
}

export async function getJobPayments(jobId: string, userId: string) {
  const job = await verifyJobOwnership(jobId, userId)
  return buildPaymentsSummary(job)
}

// ── Customer total ────────────────────────────────────────────────────────────

export async function patchCustomerTotal(
  jobId: string,
  userId: string,
  input: { customerTotalAmount?: unknown; customerTotalCurrency?: unknown },
) {
  if (!('customerTotalAmount' in input) || input.customerTotalAmount === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'customerTotalAmount is required (null clears it)' }
  }
  assertGbp(input.customerTotalCurrency, 'customerTotalCurrency')

  const amount =
    input.customerTotalAmount === null ? null : parseAmount(input.customerTotalAmount, 'customerTotalAmount')

  await verifyJobOwnership(jobId, userId)

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      customerTotalAmount: amount,
      customerTotalCurrency: amount !== null ? 'GBP' : null,
    },
  })
  return buildPaymentsSummary(updated)
}

// ── Payment CRUD ──────────────────────────────────────────────────────────────

export async function createPayment(
  jobId: string,
  userId: string,
  input: { amount?: unknown; currency?: unknown; paidAt?: unknown; note?: unknown; reference?: unknown },
) {
  if (input.amount === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'amount is required' }
  }
  if (input.paidAt === undefined) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'paidAt is required' }
  }
  const amount = parseAmount(input.amount, 'amount')
  assertGbp(input.currency, 'currency')
  const paidAt = parsePaidAt(input.paidAt)
  const note = parseOptionalText(input.note, 'note', MAX_PAYMENT_NOTE_LENGTH)
  const reference = parseOptionalText(input.reference, 'reference', MAX_PAYMENT_REFERENCE_LENGTH)

  await verifyJobOwnership(jobId, userId)

  const created = await prisma.jobPayment.create({
    data: { jobId, amount, currency: 'GBP', paidAt, note, reference },
  })
  return normalizePayment(created)
}

// Active (non-deleted) payment in this job, or 404.
async function requireActivePayment(jobId: string, paymentId: string) {
  const payment = await prisma.jobPayment.findFirst({
    where: { id: paymentId, jobId, isDeleted: false },
  })
  if (!payment) throw { code: ErrorCode.PAYMENT_NOT_FOUND, message: 'Payment not found' }
  return payment
}

export async function patchPayment(
  jobId: string,
  paymentId: string,
  userId: string,
  patch: { amount?: unknown; currency?: unknown; paidAt?: unknown; note?: unknown; reference?: unknown },
) {
  assertGbp(patch.currency, 'currency')
  const amount = patch.amount !== undefined ? parseAmount(patch.amount, 'amount') : undefined
  const paidAt = patch.paidAt !== undefined ? parsePaidAt(patch.paidAt) : undefined

  await verifyJobOwnership(jobId, userId)
  const existing = await requireActivePayment(jobId, paymentId)

  const updated = await prisma.jobPayment.update({
    where: { id: paymentId },
    data: {
      amount: amount ?? existing.amount,
      paidAt: paidAt ?? existing.paidAt,
      note: 'note' in patch ? parseOptionalText(patch.note, 'note', MAX_PAYMENT_NOTE_LENGTH) : existing.note,
      reference:
        'reference' in patch
          ? parseOptionalText(patch.reference, 'reference', MAX_PAYMENT_REFERENCE_LENGTH)
          : existing.reference,
    },
  })
  return normalizePayment(updated)
}

// Soft delete: the row stays inspectable/recoverable but leaves every normal
// summary and history read. Deleting an already-deleted payment is 404.
export async function deletePayment(jobId: string, paymentId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  await requireActivePayment(jobId, paymentId)
  await prisma.jobPayment.update({
    where: { id: paymentId },
    data: { isDeleted: true, deletedAt: new Date() },
  })
}
