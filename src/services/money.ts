// Money In/Out: the unified view of actual money movement for a job, kept
// deliberately separate from Budget (committed/allocated cost). This service is
// the ONLY place that combines the three movement sources:
//   · customer payments (JobPayment)        → Money in, kind 'customer_payment'
//   · returned-material refunds (JobMoneyEvent REFUND)  → Money in, kind 'refund'
//   · marked-paid Budget costs (JobMoneyEvent COST_PAID) → Money out, kind 'cost_paid'
// Marking a cost paid records a movement here and never mutates the source
// memory item or Budget totals. Budget endpoints must not read this module.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { strictParsePositive } from '../lib/cost-utils.js'
import { classifySpend } from '../lib/spend-classification.js'
import { ukLocalNoon } from '../lib/dates.js'

export const MAX_MONEY_NOTE_LENGTH = 120
export const MAX_MONEY_REFERENCE_LENGTH = 80

const gbp = (amount: string) => `£${amount}`
const round2 = (n: number) => String(Math.round(n * 100) / 100)

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

// occurredAt: full ISO datetime, or YYYY-MM-DD stored as UK local noon; omitted
// or null defaults to server now. Matches paidAt/happenedAt date-only handling.
function parseOccurredAt(value: unknown): Date {
  if (value == null || value === '') return new Date()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return ukLocalNoon(trimmed)
    const d = new Date(trimmed)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw { code: ErrorCode.INVALID_FIELD, message: 'occurredAt must be an ISO date/time or YYYY-MM-DD' }
}

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

// ── Row + response shapes ─────────────────────────────────────────────────────

export interface MoneyRow {
  id: string
  jobId: string
  direction: 'in' | 'out'
  kind: 'customer_payment' | 'refund' | 'cost_paid'
  amount: string
  currency: 'GBP'
  amountLabel: string
  occurredAt: string
  note: string | null
  reference: string | null
  sourceMemoryItemId: string | null
  sourceItemLabel: string | null
  sourceMemoryType: string | null
  editable: boolean
  removable: boolean
  createdAt: string
  updatedAt: string
}

const amountLabel = (direction: 'in' | 'out', amount: string) =>
  `${direction === 'in' ? '+' : '-'}${gbp(amount)}`

// A concise label for the source item behind a money event (materialName, then
// labourTask, then summary). Source items are loaded regardless of removal so a
// paid item that was later removed still reads clearly in Money.
function sourceLabel(item: { materialName: string | null; labourTask: string | null; summary: string } | undefined): string | null {
  if (!item) return null
  return item.materialName?.trim() || item.labourTask?.trim() || item.summary?.trim() || null
}

// Builds the full JobMoneyResponse from active payments + active money events.
// Customer total / still owed / overpaid track customer payments only — merchant
// refunds are Money in but do not reduce what the customer still owes.
async function buildJobMoney(job: { id: string; customerTotalAmount: string | null }) {
  const [payments, events] = await Promise.all([
    prisma.jobPayment.findMany({ where: { jobId: job.id, isDeleted: false } }),
    prisma.jobMoneyEvent.findMany({ where: { jobId: job.id, isDeleted: false } }),
  ])

  // Resolve source item labels/types for events in a single query.
  const sourceIds = [...new Set(events.map((e) => e.sourceMemoryItemId).filter((v): v is string => !!v))]
  const sourceItems = sourceIds.length
    ? await prisma.memoryItem.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, materialName: true, labourTask: true, summary: true, memoryType: true },
      })
    : []
  const sourceById = new Map(sourceItems.map((m) => [m.id, m]))

  const paymentRows: MoneyRow[] = payments.map((p) => ({
    id: p.id,
    jobId: job.id,
    direction: 'in',
    kind: 'customer_payment',
    amount: p.amount,
    currency: 'GBP',
    amountLabel: amountLabel('in', p.amount),
    occurredAt: p.paidAt.toISOString(),
    note: p.note,
    reference: p.reference,
    sourceMemoryItemId: null,
    sourceItemLabel: null,
    sourceMemoryType: null,
    editable: true,
    removable: true,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    // sort keys retained below
    _occurredAt: p.paidAt,
    _createdAt: p.createdAt,
  }) as MoneyRow & { _occurredAt: Date; _createdAt: Date })

  const eventRows: MoneyRow[] = events.map((e) => {
    const direction = e.direction === 'IN' ? 'in' : 'out'
    const src = e.sourceMemoryItemId ? sourceById.get(e.sourceMemoryItemId) : undefined
    return {
      id: e.id,
      jobId: job.id,
      direction,
      kind: e.kind === 'REFUND' ? 'refund' : 'cost_paid',
      amount: e.amount,
      currency: 'GBP',
      amountLabel: amountLabel(direction, e.amount),
      occurredAt: e.occurredAt.toISOString(),
      note: e.note,
      reference: e.reference,
      sourceMemoryItemId: e.sourceMemoryItemId,
      sourceItemLabel: sourceLabel(src),
      sourceMemoryType: src ? src.memoryType.toLowerCase() : null,
      // Money events are not free-form editable in v1 (they mirror a source);
      // they can be removed as a correction.
      editable: false,
      removable: true,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      _occurredAt: e.occurredAt,
      _createdAt: e.createdAt,
    } as MoneyRow & { _occurredAt: Date; _createdAt: Date }
  })

  const rowsWithKeys = [...paymentRows, ...eventRows] as Array<MoneyRow & { _occurredAt: Date; _createdAt: Date }>
  rowsWithKeys.sort((a, b) => {
    const t = b._occurredAt.getTime() - a._occurredAt.getTime()
    if (t !== 0) return t
    return b._createdAt.getTime() - a._createdAt.getTime()
  })
  const rows: MoneyRow[] = rowsWithKeys.map(({ _occurredAt, _createdAt, ...row }) => row)

  // Totals.
  const sum = (amounts: string[]) => amounts.reduce((s, a) => s + (strictParsePositive(a) ?? 0), 0)
  const customerPaidNum = sum(payments.map((p) => p.amount))
  const refundNum = sum(events.filter((e) => e.kind === 'REFUND').map((e) => e.amount))
  const costPaidNum = sum(events.filter((e) => e.kind === 'COST_PAID').map((e) => e.amount))

  const inRowCount = payments.length + events.filter((e) => e.kind === 'REFUND').length
  const outRowCount = events.filter((e) => e.kind === 'COST_PAID').length

  const moneyInAmount = inRowCount > 0 ? round2(customerPaidNum + refundNum) : null
  const moneyOutAmount = outRowCount > 0 ? round2(costPaidNum) : null

  // Customer owed math uses customer payments only.
  const customerTotalAmount = job.customerTotalAmount
  const totalNum = strictParsePositive(customerTotalAmount)
  let stillOwedAmount: string | null = null
  let overpaid = false
  let overpaidAmount: string | null = null
  if (totalNum !== null) {
    const owed = totalNum - customerPaidNum
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

    moneyInAmount,
    moneyInCurrency: moneyInAmount !== null ? 'GBP' : null,
    moneyInLabel: moneyInAmount !== null ? `${gbp(moneyInAmount)} received` : null,

    moneyOutAmount,
    moneyOutCurrency: moneyOutAmount !== null ? 'GBP' : null,
    moneyOutLabel: moneyOutAmount !== null ? `${gbp(moneyOutAmount)} paid out` : null,

    stillOwedAmount,
    stillOwedCurrency: stillOwedAmount !== null ? 'GBP' : null,
    stillOwedLabel: stillOwedAmount !== null ? `${gbp(stillOwedAmount)} still owed` : null,

    overpaid,
    overpaidAmount,
    overpaidLabel: overpaidAmount !== null ? `${gbp(overpaidAmount)} overpaid` : null,

    rows,
  }
}

export async function getJobMoney(jobId: string, userId: string) {
  const job = await verifyJobOwnership(jobId, userId)
  return buildJobMoney(job)
}

// ── Mark a Budget cost item as paid (Money out) ───────────────────────────────

export interface MarkMoneyOutInput {
  sourceMemoryItemId?: unknown
  occurredAt?: unknown
  note?: unknown
  reference?: unknown
}

export async function markMoneyOut(jobId: string, userId: string, input: MarkMoneyOutInput) {
  const job = await verifyJobOwnership(jobId, userId)

  if (input.sourceMemoryItemId == null || input.sourceMemoryItemId === '') {
    throw { code: ErrorCode.MISSING_FIELD, message: 'sourceMemoryItemId is required' }
  }
  if (typeof input.sourceMemoryItemId !== 'string') {
    throw { code: ErrorCode.INVALID_FIELD, message: 'sourceMemoryItemId must be a string' }
  }
  const sourceMemoryItemId = input.sourceMemoryItemId

  const occurredAt = parseOccurredAt(input.occurredAt)
  const note = parseOptionalText(input.note, 'note', MAX_MONEY_NOTE_LENGTH)
  const reference = parseOptionalText(input.reference, 'reference', MAX_MONEY_REFERENCE_LENGTH)

  const item = await prisma.memoryItem.findFirst({
    where: { id: sourceMemoryItemId, jobId, isRemoved: false },
  })
  if (!item) throw { code: ErrorCode.MEMORY_ITEM_NOT_FOUND, message: 'Memory item not found' }

  // Eligibility = the shared Budget classifier includes it as a trusted GBP cost.
  // This excludes missing-price, cost-worth-checking, unresolved, non-GBP, and
  // non-spend types (Used/Left over/Returned/notes) in one rule. The paid amount
  // is derived from the trusted line total — the client never sends it.
  const classified = classifySpend(item)
  if (classified.kind !== 'included') {
    throw { code: ErrorCode.INVALID_FIELD, message: 'Only a trusted, cost-bearing Budget item with a safe GBP total can be marked paid' }
  }
  const amount = classified.row.lineTotalAmount

  // Friendly duplicate check; the partial unique index is the race-proof guard.
  const existing = await prisma.jobMoneyEvent.findFirst({
    where: { jobId, sourceMemoryItemId, kind: 'COST_PAID', isDeleted: false },
  })
  if (existing) {
    throw { code: ErrorCode.MONEY_EVENT_ALREADY_EXISTS, message: 'This item is already marked paid' }
  }

  try {
    await prisma.jobMoneyEvent.create({
      data: {
        jobId,
        direction: 'OUT',
        kind: 'COST_PAID',
        amount,
        currency: 'GBP',
        occurredAt,
        note,
        reference,
        sourceMemoryItemId,
      },
    })
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw { code: ErrorCode.MONEY_EVENT_ALREADY_EXISTS, message: 'This item is already marked paid' }
    }
    throw err
  }

  return buildJobMoney(job)
}

// ── Remove a money event (soft delete, Money-only correction) ──────────────────

export async function deleteMoneyEvent(jobId: string, moneyEventId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const event = await prisma.jobMoneyEvent.findFirst({
    where: { id: moneyEventId, jobId, isDeleted: false },
  })
  if (!event) throw { code: ErrorCode.MONEY_EVENT_NOT_FOUND, message: 'Money event not found' }
  await prisma.jobMoneyEvent.update({
    where: { id: moneyEventId },
    data: { isDeleted: true, deletedAt: new Date() },
  })
}

// ── Refund money event (created inside the returned-material transaction) ──────

// The create-data for a REFUND Money in event linked to a returned material.
// Called from returnMaterial's transaction so the returned item and its refund
// movement commit atomically. The partial unique index prevents a duplicate
// active refund for the same returned item.
export function refundMoneyEventData(
  jobId: string,
  returnedMemoryItemId: string,
  amount: string,
  occurredAt: Date,
) {
  return {
    jobId,
    direction: 'IN' as const,
    kind: 'REFUND' as const,
    amount,
    currency: 'GBP',
    occurredAt,
    sourceMemoryItemId: returnedMemoryItemId,
  }
}
