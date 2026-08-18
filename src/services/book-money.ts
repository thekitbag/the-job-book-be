// Cross-job Money: the read-only index over money facts that already live on
// jobs. It answers exactly two questions across Mike's current book:
//
//   · which recorded supplier-account costs are still marked not paid;
//   · which jobs are recorded as still owing him customer money.
//
// This is an INDEX, not a second financial record. It writes nothing, creates
// no rows, and owns no state of its own — every figure is derived from trusted
// memory items, active COST_PAID Money events, job customer totals and active
// customer payments. Book Home's Money row and the Money overview are built
// from the same included facts here so the two can never disagree.
//
// Deliberately absent (Slice 3, not this slice): selection, mark paid,
// settlement, partial payment, supplier rename/merge, bulk correction.
import { prisma } from '../db/client.js'
import { classifySpend } from '../lib/spend-classification.js'
import { strictParsePositive, STRICT_DECIMAL_RE } from '../lib/cost-utils.js'
import { ukShortDateLabel } from '../lib/dates.js'
import {
  gbp,
  round2,
  computeGroupId,
  normalizeSupplier,
  quantityLabel,
  JOB_STATUS_LABELS,
  SUPPLIER_ACCOUNT_MEMORY_TYPES,
  SUPPLIER_NEEDED_LABEL,
  type BookJobStatus,
} from '../lib/supplier-account.js'
import {
  listSupplierAccountPaymentHistory,
  type SupplierAccountPaymentHistoryRow,
} from './supplier-payments.js'
import { isSupplierAccountSettlementEnabled } from '../config/features.js'

export type { BookJobStatus }

// Jobs whose money still counts across the book. Archived is the only status
// hidden: a finished job keeps appearing while money is outstanding.
const VISIBLE_JOB_STATUSES = ['PLANNING', 'STARTED', 'FINISHED'] as const

// ── Response types ────────────────────────────────────────────────────────────

export interface SupplierAccountLine {
  id: string
  sourceMemoryItemId: string
  jobId: string
  jobTitle: string
  jobStatus: BookJobStatus
  jobStatusLabel: string
  itemLabel: string
  quantityLabel: string | null
  amount: string
  currency: 'GBP'
  amountLabel: string
  sourceDate: string | null
  sourceDateLabel: string | null
  supplierName: string | null
  budgetCategoryId: string | null
  budgetCategoryName: string | null
}

export interface SupplierAccountGroup {
  groupId: string
  supplierName: string | null
  displayName: string
  kind: 'named_supplier' | 'supplier_needed'
  totalAmount: string
  currency: 'GBP'
  totalLabel: string
  purchaseCount: number
  distinctJobCount: number
  jobContextLabel: string
  lines: SupplierAccountLine[]
}

export type MissingPriceReason =
  | 'missing_price'
  | 'untrusted_price'
  | 'unsupported_currency'
  | 'unsafe_total'

export interface SupplierMissingPriceItem {
  id: string
  sourceMemoryItemId: string
  jobId: string
  jobTitle: string
  jobStatus: BookJobStatus
  jobStatusLabel: string
  itemLabel: string
  quantityLabel: string | null
  supplierName: string | null
  sourceDate: string | null
  sourceDateLabel: string | null
  reason: MissingPriceReason
  reasonLabel: string
}

export interface OwedToMeJob {
  jobId: string
  jobTitle: string
  jobStatus: BookJobStatus
  jobStatusLabel: string
  roughLocationOrLabel: string | null
  owedAmount: string
  currency: 'GBP'
  owedLabel: string
  customerTotalAmount: string
  customerTotalLabel: string
  moneyInAmount: string
  moneyInLabel: string
  contextLabel: string | null
}

export interface BookMoneyResponse {
  generatedAt: string
  bookHome: {
    showMoneyRow: boolean
    toPayOnAccountsAmount: string | null
    toPayOnAccountsCurrency: 'GBP' | null
    toPayOnAccountsLabel: string | null
    owedToMeAmount: string | null
    owedToMeCurrency: 'GBP' | null
    owedToMeLabel: string | null
    missingPriceCount: number
    missingPriceLabel: string | null
  }
  toPayOnAccounts: {
    totalAmount: string | null
    currency: 'GBP' | null
    totalLabel: string | null
    pricedCostCount: number
    namedSupplierCount: number
    unnamedSupplierGroupCount: number
    summaryLabel: string
    supplierGroups: SupplierAccountGroup[]
    missingPriceItems: SupplierMissingPriceItem[]
  } | null
  owedToMe: {
    totalAmount: string
    currency: 'GBP'
    totalLabel: string
    jobCount: number
    jobs: OwedToMeJob[]
  } | null
  // Real aggregate supplier payments Mike recorded, newest first. Durable: a
  // receipt stays reachable here long after its supplier's costs have left the
  // unpaid account list above.
  accountPaymentHistory: SupplierAccountPaymentHistoryRow[]
  // What this deployment will actually accept, so the client can offer only the
  // actions that exist. It reports the SAME backend gate the write routes
  // enforce — it is a description of the API, never the thing that permits a
  // write, which is always re-checked server-side.
  capabilities: BookMoneyCapabilities
}

export interface BookMoneyCapabilities {
  supplierAccountSettlement: boolean
}

function capabilities(): BookMoneyCapabilities {
  return { supplierAccountSettlement: isSupplierAccountSettlementEnabled() }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// A trusted £0 cost is deliberately no-cost, not an unknown price: it is
// neither payable nor a missing-price correction, so it leaves this view
// entirely rather than appearing as a £0 line.
function isTrustedZeroCost(item: {
  costAmount: string | null
  totalCostAmount: string | null
  costCurrency: string | null
  unresolvedFlags: string[]
}): boolean {
  if (item.unresolvedFlags.length > 0 || item.costCurrency !== 'GBP') return false
  const zero = (v: string | null) => v != null && STRICT_DECIMAL_RE.test(v) && parseFloat(v) === 0
  return zero(item.totalCostAmount) || zero(item.costAmount)
}

// Why an eligible purchase cannot enter the totals. The shared classifier
// already decided it is excluded; this only names the reason for Mike so the
// correction he needs is obvious.
function missingPriceReason(item: {
  costAmount: string | null
  totalCostAmount: string | null
  costCurrency: string | null
  unresolvedFlags: string[]
}): MissingPriceReason {
  if (item.unresolvedFlags.length > 0) return 'untrusted_price'
  if (item.costCurrency && item.costCurrency !== 'GBP') return 'unsupported_currency'
  if (!item.totalCostAmount && item.costAmount) return 'unsafe_total'
  if (!item.totalCostAmount) return 'missing_price'
  return 'untrusted_price'
}

const MISSING_PRICE_REASON_LABELS: Record<MissingPriceReason, string> = {
  missing_price: 'cost has no price yet',
  untrusted_price: 'price needs checking',
  unsupported_currency: "price isn't in £",
  unsafe_total: 'total needs checking',
}

function missingPriceReasonLabel(reason: MissingPriceReason, total: string | null): string {
  const base = MISSING_PRICE_REASON_LABELS[reason]
  return total === null ? base : `${base} — can't be in the ${gbp(total)}`
}

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm

// The two facts the total itself cannot carry: how many costs make it up, and
// how many accounts they sit on. Deliberately does NOT repeat the total, which
// is already the largest thing on the screen (and `totalLabel`). Parts are
// joined with ' · ' so a client can split and stack them.
// "priced costs", not the design's "recorded costs": unpriced recorded costs
// exist and are excluded from this count, so the narrower word is the true one.
function accountsSummaryLabel(pricedCostCount: number, namedSupplierCount: number, unnamedGroupCount: number): string {
  const costs = `${pricedCostCount} priced ${plural(pricedCostCount, 'cost', 'costs')}`
  const accounts = namedSupplierCount > 0
    ? `${namedSupplierCount} ${plural(namedSupplierCount, 'account', 'accounts')}${unnamedGroupCount > 0 ? ', 1 unnamed' : ''}`
    : unnamedGroupCount > 0
      ? 'no supplier named yet'
      : null
  return accounts === null ? costs : `${costs} · ${accounts}`
}

// ── Read model ────────────────────────────────────────────────────────────────

type JobRow = {
  id: string
  title: string
  status: string
  roughLocationOrLabel: string | null
  customerTotalAmount: string | null
}

interface SourceContext {
  jobId: string
  jobTitle: string
  jobStatus: BookJobStatus
  jobStatusLabel: string
}

function jobContext(job: JobRow): SourceContext {
  const status = job.status.toLowerCase() as BookJobStatus
  return {
    jobId: job.id,
    jobTitle: job.title,
    jobStatus: status,
    jobStatusLabel: JOB_STATUS_LABELS[status] ?? 'In progress',
  }
}

export async function getBookMoney(userId: string): Promise<BookMoneyResponse> {
  const generatedAt = new Date().toISOString()

  // Owner scoping happens once, here: every later query is keyed on these job
  // ids, so no row from another user's job can enter the read model.
  const jobs = (await prisma.job.findMany({
    where: { ownerUserId: userId, status: { in: [...VISIBLE_JOB_STATUSES] as never } },
    select: {
      id: true,
      title: true,
      status: true,
      roughLocationOrLabel: true,
      customerTotalAmount: true,
    },
  })) as JobRow[]

  // History is owner-scoped, not job-scoped: it survives even a book whose jobs
  // have all been archived, so a recorded payment never becomes unreachable.
  const accountPaymentHistory = await listSupplierAccountPaymentHistory(userId)

  const jobIds = jobs.map((j) => j.id)
  if (jobIds.length === 0) return emptyResponse(generatedAt, accountPaymentHistory)

  const [items, paidEvents, payments, categories] = await Promise.all([
    prisma.memoryItem.findMany({
      where: {
        jobId: { in: jobIds },
        isRemoved: false,
        memoryType: { in: [...SUPPLIER_ACCOUNT_MEMORY_TYPES] as never },
      },
    }),
    prisma.jobMoneyEvent.findMany({
      where: { jobId: { in: jobIds }, kind: 'COST_PAID', isDeleted: false },
      select: { sourceMemoryItemId: true },
    }),
    prisma.jobPayment.findMany({
      where: { jobId: { in: jobIds }, isDeleted: false },
      select: { jobId: true, amount: true },
    }),
    prisma.jobBudgetCategory.findMany({
      where: { jobId: { in: jobIds } },
      select: { id: true, name: true },
    }),
  ])

  const jobById = new Map(jobs.map((j) => [j.id, j]))
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]))
  const paidItemIds = new Set(
    paidEvents.map((e) => e.sourceMemoryItemId).filter((id): id is string => id !== null),
  )

  // ── To pay on accounts ─────────────────────────────────────────────────────

  type LineWithSort = SupplierAccountLine & { _sortAt: number; _createdAt: number }
  const linesBySupplierKey = new Map<string, { supplierName: string | null; lines: LineWithSort[] }>()
  const missingPriceItems: Array<SupplierMissingPriceItem & { _sortAt: number; _createdAt: number }> = []

  for (const item of items) {
    const job = jobById.get(item.jobId)
    if (!job) continue
    // Already marked paid at the source: it is a recorded movement, not
    // something still to pay on the account.
    if (paidItemIds.has(item.id)) continue
    if (isTrustedZeroCost(item)) continue

    const context = jobContext(job)
    const supplierName = normalizeSupplier(item.supplierName)
    const sourceAt = item.happenedAt ?? null
    const sortAt = (item.happenedAt ?? item.createdAt).getTime()
    const classified = classifySpend(item)

    if (classified.kind === 'included') {
      const key = supplierName === null ? 'supplier_needed' : `named:${supplierName}`
      const bucket = linesBySupplierKey.get(key) ?? { supplierName, lines: [] }
      bucket.lines.push({
        id: item.id,
        sourceMemoryItemId: item.id,
        ...context,
        itemLabel: classified.row.itemLabel,
        quantityLabel: quantityLabel(item.quantity, item.unit),
        amount: classified.row.lineTotalAmount,
        currency: 'GBP',
        amountLabel: gbp(classified.row.lineTotalAmount),
        sourceDate: sourceAt ? sourceAt.toISOString() : null,
        sourceDateLabel: sourceAt ? ukShortDateLabel(sourceAt) : null,
        supplierName,
        budgetCategoryId: item.budgetCategoryId,
        budgetCategoryName: item.budgetCategoryId
          ? categoryNameById.get(item.budgetCategoryId) ?? null
          : null,
        _sortAt: sortAt,
        _createdAt: item.createdAt.getTime(),
      })
      linesBySupplierKey.set(key, bucket)
      continue
    }

    if (classified.kind === 'excluded') {
      // Missing/untrusted price: visible so it can be corrected, but never in a
      // total and never shown as £0. An item missing BOTH price and supplier
      // appears here only — it is not also listed under Supplier needed.
      const reason = missingPriceReason(item)
      missingPriceItems.push({
        id: item.id,
        sourceMemoryItemId: item.id,
        ...context,
        itemLabel: classified.row.itemLabel,
        quantityLabel: quantityLabel(item.quantity, item.unit),
        supplierName,
        sourceDate: sourceAt ? sourceAt.toISOString() : null,
        sourceDateLabel: sourceAt ? ukShortDateLabel(sourceAt) : null,
        reason,
        reasonLabel: '',
        _sortAt: sortAt,
        _createdAt: item.createdAt.getTime(),
      })
    }
  }

  const sortOldestFirst = <T extends { _sortAt: number; _createdAt: number; id: string }>(rows: T[]) =>
    rows.sort((a, b) => a._sortAt - b._sortAt || a._createdAt - b._createdAt || a.id.localeCompare(b.id))

  const groups: SupplierAccountGroup[] = []
  for (const [key, bucket] of linesBySupplierKey) {
    const lines = sortOldestFirst(bucket.lines).map(({ _sortAt, _createdAt, ...line }) => line)
    const total = round2(lines.reduce((sum, l) => sum + (strictParsePositive(l.amount) ?? 0), 0))
    const distinctJobCount = new Set(lines.map((l) => l.jobId)).size
    const named = bucket.supplierName !== null
    groups.push({
      groupId: computeGroupId(userId, key),
      supplierName: bucket.supplierName,
      displayName: bucket.supplierName ?? SUPPLIER_NEEDED_LABEL,
      kind: named ? 'named_supplier' : 'supplier_needed',
      totalAmount: total,
      currency: 'GBP',
      totalLabel: gbp(total),
      purchaseCount: lines.length,
      distinctJobCount,
      // One job reads better as its name than as "1 job".
      jobContextLabel: distinctJobCount === 1 ? lines[0].jobTitle : `${distinctJobCount} jobs`,
      lines,
    })
  }

  // Named suppliers by total desc (display name as the stable tie-break),
  // then Supplier needed last.
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'named_supplier' ? -1 : 1
    const diff = parseFloat(b.totalAmount) - parseFloat(a.totalAmount)
    if (Math.abs(diff) > 0.001) return diff
    return a.displayName.localeCompare(b.displayName)
  })

  const pricedCostCount = groups.reduce((sum, g) => sum + g.purchaseCount, 0)
  const toPayTotal = pricedCostCount > 0
    ? round2(groups.reduce((sum, g) => sum + parseFloat(g.totalAmount), 0))
    : null

  const missingPrice = sortOldestFirst(missingPriceItems).map(({ _sortAt, _createdAt, ...row }) => ({
    ...row,
    reasonLabel: missingPriceReasonLabel(row.reason, toPayTotal),
  }))

  const namedSupplierCount = groups.filter((g) => g.kind === 'named_supplier').length
  const unnamedSupplierGroupCount = groups.filter((g) => g.kind === 'supplier_needed').length

  const toPayOnAccounts = pricedCostCount === 0 && missingPrice.length === 0
    ? null
    : {
        totalAmount: toPayTotal,
        currency: (toPayTotal === null ? null : 'GBP') as 'GBP' | null,
        totalLabel: toPayTotal === null ? null : gbp(toPayTotal),
        pricedCostCount,
        namedSupplierCount,
        unnamedSupplierGroupCount,
        summaryLabel: toPayTotal === null
          ? `${missingPrice.length} ${plural(missingPrice.length, 'cost needs', 'costs need')} a price`
          : accountsSummaryLabel(pricedCostCount, namedSupplierCount, unnamedSupplierGroupCount),
        supplierGroups: groups,
        missingPriceItems: missingPrice,
      }

  // ── Owed to me ─────────────────────────────────────────────────────────────

  // Customer payments only, matching the job-level Money view: a merchant
  // refund is money in but never reduces what a customer still owes.
  const paidByJob = new Map<string, number>()
  for (const payment of payments) {
    paidByJob.set(payment.jobId, (paidByJob.get(payment.jobId) ?? 0) + (strictParsePositive(payment.amount) ?? 0))
  }

  const owedJobs: OwedToMeJob[] = []
  for (const job of jobs) {
    const total = strictParsePositive(job.customerTotalAmount)
    // No trusted customer total: nothing is recorded as owed. Never inferred
    // from free text, invoice stages or completion terms.
    if (total === null) continue
    const received = paidByJob.get(job.id) ?? 0
    const owed = Math.round((total - received) * 100) / 100
    // Zero owed and overpaid jobs leave the list rather than showing £0 or a
    // negative owed figure.
    if (owed <= 0) continue

    const context = jobContext(job)
    const owedAmount = round2(owed)
    const receivedAmount = round2(received)
    owedJobs.push({
      ...context,
      roughLocationOrLabel: job.roughLocationOrLabel,
      owedAmount,
      currency: 'GBP',
      owedLabel: `${gbp(owedAmount)} owed`,
      customerTotalAmount: job.customerTotalAmount as string,
      customerTotalLabel: gbp(job.customerTotalAmount as string),
      moneyInAmount: receivedAmount,
      moneyInLabel: `${gbp(receivedAmount)} received`,
      contextLabel: context.jobStatus === 'finished' ? 'finished job' : null,
    })
  }
  owedJobs.sort(
    (a, b) =>
      parseFloat(b.owedAmount) - parseFloat(a.owedAmount) ||
      a.jobTitle.localeCompare(b.jobTitle) ||
      a.jobId.localeCompare(b.jobId),
  )

  const owedTotal = owedJobs.length
    ? round2(owedJobs.reduce((sum, j) => sum + parseFloat(j.owedAmount), 0))
    : null

  const owedToMe = owedTotal === null
    ? null
    : {
        totalAmount: owedTotal,
        currency: 'GBP' as const,
        totalLabel: gbp(owedTotal),
        jobCount: owedJobs.length,
        jobs: owedJobs,
      }

  // ── Book Home summary ──────────────────────────────────────────────────────
  // Derived from exactly the figures above — Book Home never does its own
  // arithmetic, so its row and the overview cannot drift apart.

  const missingPriceCount = missingPrice.length
  return {
    generatedAt,
    bookHome: {
      showMoneyRow:
        toPayTotal !== null || owedTotal !== null || missingPriceCount > 0 || accountPaymentHistory.length > 0,
      toPayOnAccountsAmount: toPayTotal,
      toPayOnAccountsCurrency: toPayTotal === null ? null : 'GBP',
      toPayOnAccountsLabel: toPayTotal === null ? null : `${gbp(toPayTotal)} to pay on accounts`,
      owedToMeAmount: owedTotal,
      owedToMeCurrency: owedTotal === null ? null : 'GBP',
      owedToMeLabel: owedTotal === null ? null : `${gbp(owedTotal)} owed to me`,
      missingPriceCount,
      missingPriceLabel: missingPriceCount === 0
        ? null
        : `${missingPriceCount} ${plural(missingPriceCount, 'cost needs', 'costs need')} a price`,
    },
    toPayOnAccounts,
    owedToMe,
    accountPaymentHistory,
    capabilities: capabilities(),
  }
}

function emptyResponse(
  generatedAt: string,
  accountPaymentHistory: SupplierAccountPaymentHistoryRow[],
): BookMoneyResponse {
  return {
    generatedAt,
    bookHome: {
      // A bare Money row when history is the only Money content — never a fake
      // £0 balance, which would read as "nothing owed" rather than "nothing new".
      showMoneyRow: accountPaymentHistory.length > 0,
      toPayOnAccountsAmount: null,
      toPayOnAccountsCurrency: null,
      toPayOnAccountsLabel: null,
      owedToMeAmount: null,
      owedToMeCurrency: null,
      owedToMeLabel: null,
      missingPriceCount: 0,
      missingPriceLabel: null,
    },
    toPayOnAccounts: null,
    owedToMe: null,
    accountPaymentHistory,
    capabilities: capabilities(),
  }
}
