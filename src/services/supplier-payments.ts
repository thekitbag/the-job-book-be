// Supplier account settlement across jobs.
//
// One real payment Mike made to one named supplier, covering WHOLE recorded
// costs that may sit on several jobs. It answers exactly one question:
//
//   which recorded supplier costs did this payment cover, and how much of it
//   belongs to each job?
//
// It deliberately does NOT claim bank reconciliation, supplier-statement
// matching or "account cleared". Nothing here touches Budget: settlement moves
// paid state and Money out only, so known cost, allowance and remaining are the
// same figures before and after a payment (and after Undo).
//
// Model: the aggregate `SupplierAccountPayment` row is the durable receipt.
// Each covered cost still gets its own COST_PAID `JobMoneyEvent`, linked back by
// `supplierAccountPaymentId`, so existing paid-state mechanics (Budget, the
// cross-job unpaid account list, the partial unique index that makes a double
// mark-paid impossible) keep working untouched. Job Money then GROUPS those
// child markers into one visible allocation row per job, so an aggregate payment
// is never double-counted on a job. Undo is aggregate-only.
//
// Writes here are gated by SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED (default off).
// The backend owns that decision: a frontend flag can hide the UI, but only this
// gate can stop a payment being recorded.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { classifySpend } from '../lib/spend-classification.js'
import { strictParsePositive } from '../lib/cost-utils.js'
import { ukLocalNoon, ukLocalDayString, ukShortDateLabel } from '../lib/dates.js'
import { isSupplierAccountSettlementEnabled } from '../config/features.js'
import {
  gbp,
  round2,
  quantityLabel,
  normalizeSupplier,
  supplierGroupIdFor,
  SUPPLIER_ACCOUNT_MEMORY_TYPES,
  SUPPLIER_NEEDED_LABEL,
  JOB_STATUS_LABELS,
  type BookJobStatus,
} from '../lib/supplier-account.js'

const DAY_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

// Every revalidation failure reads the same to the client: the account moved
// under the selection, so re-read it. The `reason` is diagnostic detail, never
// a hint about another user's data.
type StaleReason =
  | 'source_not_found'
  | 'job_archived'
  | 'not_supplier_account_cost'
  | 'supplier_changed'
  | 'price_not_settleable'
  | 'already_paid'
  | 'concurrent_payment'
  | 'payment_undone'

function staleSelection(reason: StaleReason): never {
  throw {
    code: ErrorCode.SUPPLIER_PAYMENT_STALE_SELECTION,
    message: 'This account changed. Review the current costs and try again',
    reason,
  }
}

// Every settlement write passes through here first. The gate lives in the
// service, not the route, so no other caller can reach a write around it.
function assertSettlementEnabled(): void {
  if (isSupplierAccountSettlementEnabled()) return
  throw {
    code: ErrorCode.SUPPLIER_SETTLEMENT_DISABLED,
    message: 'Supplier account settlement is not enabled',
  }
}

const notFound = (): never => {
  throw { code: ErrorCode.SUPPLIER_PAYMENT_NOT_FOUND, message: 'Supplier payment not found' }
}

// ── Response types ────────────────────────────────────────────────────────────

export interface SupplierPaymentSourceLine {
  sourceMemoryItemId: string
  itemLabel: string
  quantityLabel: string | null
  amount: string
  currency: 'GBP'
  amountLabel: string
  sourceDate: string | null
  sourceDateLabel: string | null
  budgetCategoryId: string | null
  budgetCategoryName: string | null
}

export interface SupplierPaymentJobAllocation {
  jobId: string
  jobTitle: string
  jobStatus: BookJobStatus
  jobStatusLabel: string
  amount: string
  currency: 'GBP'
  amountLabel: string
  sourceLines: SupplierPaymentSourceLine[]
}

export interface SupplierAccountPaymentReceipt {
  id: string
  supplierName: string
  paidAt: string
  paidAtLabel: string
  totalAmount: string
  currency: 'GBP'
  totalLabel: string
  costCount: number
  jobCount: number
  budgetsUnchanged: true
  isDeleted: boolean
  canUndo: boolean
  canChangeDate: boolean
  allocations: SupplierPaymentJobAllocation[]
}

export interface SupplierAccountPaymentHistoryRow {
  id: string
  supplierName: string
  paidAt: string
  paidAtLabel: string
  totalAmount: string
  currency: 'GBP'
  totalLabel: string
  costCount: number
  jobCount: number
}

// ── Input parsing ─────────────────────────────────────────────────────────────

export interface CreateSupplierAccountPaymentInput {
  supplierGroupId?: unknown
  supplierName?: unknown
  sourceMemoryItemIds?: unknown
  paidAt?: unknown
  clientRequestId?: unknown
}

function requiredString(value: unknown, field: string): string {
  if (value == null || value === '') {
    throw { code: ErrorCode.MISSING_FIELD, message: `${field} is required` }
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw { code: ErrorCode.INVALID_FIELD, message: `${field} must be a non-empty string` }
  }
  return value.trim()
}

// A settlement records a payment that has already happened: today or a past day,
// never a future one. Date-only is stored as UK local noon so the intended day
// survives a UTC round-trip, matching every other effective date in the pilot.
function parsePaidAt(value: unknown, { required }: { required: boolean }): Date {
  if (value == null || value === '') {
    if (required) throw { code: ErrorCode.MISSING_FIELD, message: 'paidAt is required' }
    return new Date()
  }
  if (typeof value !== 'string') {
    throw { code: ErrorCode.INVALID_FIELD, message: 'paidAt must be an ISO date/time or YYYY-MM-DD' }
  }
  const trimmed = value.trim()
  const future = () => {
    throw { code: ErrorCode.INVALID_FIELD, message: 'paidAt cannot be in the future' }
  }
  if (DAY_ONLY_RE.test(trimmed)) {
    if (trimmed > ukLocalDayString(new Date())) future()
    return ukLocalNoon(trimmed)
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'paidAt must be an ISO date/time or YYYY-MM-DD' }
  }
  if (parsed.getTime() > Date.now()) future()
  return parsed
}

function parseSourceIds(value: unknown): string[] {
  if (value == null) throw { code: ErrorCode.MISSING_FIELD, message: 'sourceMemoryItemIds is required' }
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'sourceMemoryItemIds must be an array of memory item ids' }
  }
  // The same line ticked twice is still one cost, not a double payment.
  const ids = [...new Set((value as string[]).map((v) => v.trim()))]
  if (ids.length === 0) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'Select at least one cost to mark paid' }
  }
  return ids
}

// ── Receipt reconstruction ────────────────────────────────────────────────────

type PaymentRow = {
  id: string
  ownerUserId: string
  supplierName: string
  amount: string
  paidAt: Date
  isDeleted: boolean
}

// Rebuilds the receipt from the aggregate row plus its linked child markers.
// Reads sources regardless of later removal so a receipt stays readable after
// the supplier has no unpaid costs left and its group has left the account list.
async function buildReceipt(payment: PaymentRow): Promise<SupplierAccountPaymentReceipt> {
  const events = await prisma.jobMoneyEvent.findMany({
    where: {
      supplierAccountPaymentId: payment.id,
      // An active payment shows its active markers. An undone payment keeps its
      // receipt readable by showing the markers it soft-deleted.
      ...(payment.isDeleted ? {} : { isDeleted: false }),
    },
    select: { jobId: true, amount: true, sourceMemoryItemId: true, createdAt: true },
  })

  const jobIds = [...new Set(events.map((e) => e.jobId))]
  const sourceIds = events.map((e) => e.sourceMemoryItemId).filter((id): id is string => id !== null)

  const [jobs, items] = await Promise.all([
    jobIds.length
      ? prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, status: true } })
      : Promise.resolve([]),
    sourceIds.length
      ? prisma.memoryItem.findMany({
          where: { id: { in: sourceIds } },
          select: {
            id: true, jobId: true, materialName: true, labourTask: true, summary: true,
            quantity: true, unit: true, happenedAt: true, createdAt: true, budgetCategoryId: true,
          },
        })
      : Promise.resolve([]),
  ])

  const categoryIds = [...new Set(items.map((i) => i.budgetCategoryId).filter((id): id is string => id !== null))]
  const categories = categoryIds.length
    ? await prisma.jobBudgetCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
    : []
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]))
  const itemById = new Map(items.map((i) => [i.id, i]))
  const jobById = new Map(jobs.map((j) => [j.id, j]))

  type LineWithSort = SupplierPaymentSourceLine & { _sortAt: number }
  const linesByJob = new Map<string, LineWithSort[]>()

  for (const event of events) {
    const item = event.sourceMemoryItemId ? itemById.get(event.sourceMemoryItemId) : undefined
    const sourceAt = item?.happenedAt ?? null
    const line: LineWithSort = {
      sourceMemoryItemId: event.sourceMemoryItemId ?? '',
      itemLabel: item?.materialName?.trim() || item?.labourTask?.trim() || item?.summary?.trim() || 'Recorded cost',
      quantityLabel: item ? quantityLabel(item.quantity, item.unit) : null,
      // The amount covered is the figure recorded at settlement, not a figure
      // re-derived now: the receipt must keep saying what was actually paid.
      amount: event.amount,
      currency: 'GBP',
      amountLabel: gbp(event.amount),
      sourceDate: sourceAt ? sourceAt.toISOString() : null,
      sourceDateLabel: sourceAt ? ukShortDateLabel(sourceAt) : null,
      budgetCategoryId: item?.budgetCategoryId ?? null,
      budgetCategoryName: item?.budgetCategoryId ? categoryNameById.get(item.budgetCategoryId) ?? null : null,
      _sortAt: (item?.happenedAt ?? item?.createdAt ?? event.createdAt).getTime(),
    }
    const bucket = linesByJob.get(event.jobId) ?? []
    bucket.push(line)
    linesByJob.set(event.jobId, bucket)
  }

  const allocations: SupplierPaymentJobAllocation[] = []
  for (const [jobId, lines] of linesByJob) {
    lines.sort((a, b) => a._sortAt - b._sortAt || a.sourceMemoryItemId.localeCompare(b.sourceMemoryItemId))
    const job = jobById.get(jobId)
    const status = (job?.status.toLowerCase() ?? 'started') as BookJobStatus
    const amount = round2(lines.reduce((sum, l) => sum + (strictParsePositive(l.amount) ?? 0), 0))
    allocations.push({
      jobId,
      jobTitle: job?.title ?? 'Job',
      jobStatus: status,
      jobStatusLabel: JOB_STATUS_LABELS[status] ?? 'In progress',
      amount,
      currency: 'GBP',
      // Money out on that job, so the allocation reads as a movement: "-£3,250".
      amountLabel: `-${gbp(amount)}`,
      sourceLines: lines.map(({ _sortAt, ...line }) => line),
    })
  }
  allocations.sort((a, b) => a.jobTitle.localeCompare(b.jobTitle) || a.jobId.localeCompare(b.jobId))

  return {
    id: payment.id,
    supplierName: payment.supplierName,
    paidAt: payment.paidAt.toISOString(),
    paidAtLabel: ukShortDateLabel(payment.paidAt),
    totalAmount: payment.amount,
    currency: 'GBP',
    totalLabel: gbp(payment.amount),
    costCount: events.length,
    jobCount: allocations.length,
    // Stated, not computed: settlement has no path that can move Budget.
    budgetsUnchanged: true,
    isDeleted: payment.isDeleted,
    canUndo: !payment.isDeleted,
    canChangeDate: !payment.isDeleted,
    allocations,
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createSupplierAccountPayment(
  userId: string,
  input: CreateSupplierAccountPaymentInput,
): Promise<{ receipt: SupplierAccountPaymentReceipt; created: boolean }> {
  assertSettlementEnabled()
  const clientRequestId = requiredString(input.clientRequestId, 'clientRequestId')
  const supplierName = requiredString(input.supplierName, 'supplierName')
  const supplierGroupId = requiredString(input.supplierGroupId, 'supplierGroupId')
  const sourceMemoryItemIds = parseSourceIds(input.sourceMemoryItemIds)
  const paidAt = parsePaidAt(input.paidAt, { required: false })

  // Settlement is named-supplier only. `Supplier needed` is a correction prompt,
  // not an account: there is nothing honest to pay it against.
  if (supplierName === SUPPLIER_NEEDED_LABEL) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'Only a named supplier account can be marked paid' }
  }
  if (supplierGroupId !== supplierGroupIdFor(userId, supplierName)) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'supplierGroupId does not match this supplier account' }
  }

  // Idempotency: the same submit retried after a success (or after a response
  // was lost) returns the receipt that already exists, writing nothing.
  const existing = await prisma.supplierAccountPayment.findUnique({
    where: { ownerUserId_clientRequestId: { ownerUserId: userId, clientRequestId } },
  })
  if (existing) {
    // A request id whose payment was undone cannot silently re-settle: the
    // covered costs are back to not paid and the selection must be re-made.
    if (existing.isDeleted) staleSelection('payment_undone')
    return { receipt: await buildReceipt(existing), created: false }
  }

  const paymentId = await prisma.$transaction(async (tx) => {
    // Everything is re-checked HERE, inside the write, against current rows —
    // the selection the client sent is only a list of ids.
    const items = await tx.memoryItem.findMany({
      where: { id: { in: sourceMemoryItemIds }, isRemoved: false },
      include: { job: { select: { id: true, ownerUserId: true, status: true } } },
    })
    // A missing id covers "removed", "never existed" and "another user's cost"
    // in one answer that leaks nothing.
    if (items.length !== sourceMemoryItemIds.length) staleSelection('source_not_found')

    let total = 0
    const eventData: Array<{ jobId: string; sourceMemoryItemId: string; amount: string }> = []
    for (const item of items) {
      if (item.job.ownerUserId !== userId) staleSelection('source_not_found')
      if (item.job.status === 'ARCHIVED') staleSelection('job_archived')
      if (!(SUPPLIER_ACCOUNT_MEMORY_TYPES as readonly string[]).includes(item.memoryType)) {
        staleSelection('not_supplier_account_cost')
      }
      if (normalizeSupplier(item.supplierName) !== supplierName) staleSelection('supplier_changed')

      // The amount is derived here, from the trusted line total — the client
      // never sends one, so there is no way to record a figure the memory does
      // not support. This also excludes missing/untrusted/non-GBP and £0 prices.
      const classified = classifySpend(item)
      if (classified.kind !== 'included') staleSelection('price_not_settleable')
      total += strictParsePositive(classified.row.lineTotalAmount) ?? 0
      eventData.push({
        jobId: item.jobId,
        sourceMemoryItemId: item.id,
        amount: classified.row.lineTotalAmount,
      })
    }

    // Already paid — individually or by another aggregate payment.
    const alreadyPaid = await tx.jobMoneyEvent.findFirst({
      where: { sourceMemoryItemId: { in: sourceMemoryItemIds }, kind: 'COST_PAID', isDeleted: false },
      select: { id: true },
    })
    if (alreadyPaid) staleSelection('already_paid')

    const payment = await tx.supplierAccountPayment.create({
      data: {
        ownerUserId: userId,
        supplierName,
        amount: round2(total),
        currency: 'GBP',
        paidAt,
        clientRequestId,
      },
    })

    // All of them or none: this createMany is inside the transaction, and the
    // partial unique index on active (jobId, sourceMemoryItemId, COST_PAID)
    // makes the concurrent-duplicate race fail the whole write rather than
    // paying one cost twice.
    await tx.jobMoneyEvent.createMany({
      data: eventData.map((e) => ({
        jobId: e.jobId,
        direction: 'OUT' as const,
        kind: 'COST_PAID' as const,
        amount: e.amount,
        currency: 'GBP',
        occurredAt: paidAt,
        sourceMemoryItemId: e.sourceMemoryItemId,
        supplierAccountPaymentId: payment.id,
      })),
    })

    return payment.id
  }).catch((err: unknown) => {
    const code = (err as { code?: string })?.code
    // A concurrent settlement won the race for one of these costs (or for this
    // clientRequestId). Nothing was written by this request.
    if (code === 'P2002') staleSelection('concurrent_payment')
    throw err
  })

  const payment = await prisma.supplierAccountPayment.findUnique({ where: { id: paymentId } })
  if (!payment) return notFound()
  return { receipt: await buildReceipt(payment), created: true }
}

// ── Read ──────────────────────────────────────────────────────────────────────

async function loadOwnedPayment(userId: string, paymentId: string, { allowDeleted = false } = {}) {
  const payment = await prisma.supplierAccountPayment.findUnique({ where: { id: paymentId } })
  // Cross-user and undone payments are indistinguishable from unknown ones.
  if (!payment || payment.ownerUserId !== userId) return notFound()
  if (payment.isDeleted && !allowDeleted) return notFound()
  return payment
}

export async function getSupplierAccountPayment(userId: string, paymentId: string) {
  return buildReceipt(await loadOwnedPayment(userId, paymentId))
}

// ── Change payment date ───────────────────────────────────────────────────────

// The only correction a recorded payment allows. Amount, supplier, covered costs
// and allocations are fixed at settlement; correcting any of those means undoing
// the payment, fixing the source, and recording the payment again.
export async function patchSupplierAccountPaymentDate(
  userId: string,
  paymentId: string,
  input: { paidAt?: unknown },
) {
  assertSettlementEnabled()
  const payment = await loadOwnedPayment(userId, paymentId)
  const paidAt = parsePaidAt(input.paidAt, { required: true })

  await prisma.$transaction(async (tx) => {
    await tx.supplierAccountPayment.update({ where: { id: payment.id }, data: { paidAt } })
    // The job-level allocation must read with the same date as the receipt.
    await tx.jobMoneyEvent.updateMany({
      where: { supplierAccountPaymentId: payment.id, isDeleted: false },
      data: { occurredAt: paidAt },
    })
  })

  return buildReceipt({ ...payment, paidAt })
}

// ── Undo ──────────────────────────────────────────────────────────────────────

// Aggregate only: every covered cost goes back to not paid together. Budget is
// untouched, because it never saw the payment in the first place.
export async function undoSupplierAccountPayment(userId: string, paymentId: string) {
  assertSettlementEnabled()
  const payment = await loadOwnedPayment(userId, paymentId)
  const deletedAt = new Date()

  await prisma.$transaction(async (tx) => {
    // Guarded on isDeleted so a double Undo cannot soft-delete twice; the second
    // request finds nothing to update and the read below reports the 404.
    const updated = await tx.supplierAccountPayment.updateMany({
      where: { id: payment.id, isDeleted: false },
      data: { isDeleted: true, deletedAt },
    })
    if (updated.count === 0) return
    await tx.jobMoneyEvent.updateMany({
      where: { supplierAccountPaymentId: payment.id, isDeleted: false },
      data: { isDeleted: true, deletedAt },
    })
  })

  const after = await prisma.supplierAccountPayment.findUnique({ where: { id: payment.id } })
  if (!after || !after.isDeleted) return notFound()
  return buildReceipt(after)
}

// ── Account payment history (cross-job Money) ─────────────────────────────────

// Real aggregate payments only. Individually marked-paid costs are not invented
// into history — they were never one supplier payment.
export async function listSupplierAccountPaymentHistory(
  userId: string,
): Promise<SupplierAccountPaymentHistoryRow[]> {
  const payments = await prisma.supplierAccountPayment.findMany({
    where: { ownerUserId: userId, isDeleted: false },
    orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
  })
  if (payments.length === 0) return []

  const events = await prisma.jobMoneyEvent.findMany({
    where: { supplierAccountPaymentId: { in: payments.map((p) => p.id) }, isDeleted: false },
    select: { supplierAccountPaymentId: true, jobId: true },
  })
  const countsByPayment = new Map<string, { costCount: number; jobIds: Set<string> }>()
  for (const event of events) {
    const key = event.supplierAccountPaymentId as string
    const entry = countsByPayment.get(key) ?? { costCount: 0, jobIds: new Set<string>() }
    entry.costCount += 1
    entry.jobIds.add(event.jobId)
    countsByPayment.set(key, entry)
  }

  return payments.map((p) => {
    const counts = countsByPayment.get(p.id)
    return {
      id: p.id,
      supplierName: p.supplierName,
      paidAt: p.paidAt.toISOString(),
      paidAtLabel: ukShortDateLabel(p.paidAt),
      totalAmount: p.amount,
      currency: 'GBP' as const,
      totalLabel: gbp(p.amount),
      costCount: counts?.costCount ?? 0,
      jobCount: counts?.jobIds.size ?? 0,
    }
  })
}

// ── Guard shared with the single-cost paid/edit routes ────────────────────────

// The aggregate payment (if any) that currently owns a source cost's paid state.
// Single-cost Undo paid, and financially material edits to the source, must not
// silently break an aggregate receipt — they are redirected to it instead.
export async function activeSupplierPaymentOwning(sourceMemoryItemId: string): Promise<string | null> {
  // Some suites drive these services with a partial prisma mock; a missing money
  // event table there means no aggregate payment can own anything.
  if (typeof prisma.jobMoneyEvent?.findFirst !== 'function') return null
  const event = await prisma.jobMoneyEvent.findFirst({
    where: {
      sourceMemoryItemId,
      kind: 'COST_PAID',
      isDeleted: false,
      supplierAccountPaymentId: { not: null },
    },
    select: { supplierAccountPaymentId: true },
  })
  return event?.supplierAccountPaymentId ?? null
}

export function supplierPaymentOwnsCost(
  supplierAccountPaymentId: string,
  message = 'Undo the supplier payment to change this paid state',
): never {
  throw { code: ErrorCode.SUPPLIER_PAYMENT_OWNS_COST, message, supplierAccountPaymentId }
}
