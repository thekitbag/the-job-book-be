// Supplier account settlement across jobs: one aggregate named-supplier payment
// covering whole recorded costs on several jobs.
//
// These tests pin the things that would be release-blocking if they broke — no
// partial write, no duplicate payment, no double-counted job Money, no Budget
// movement, and an Undo that puts every covered cost back — plus the eligibility
// boundary that stops a payment being recorded against something the memory
// cannot honestly tie to a supplier account. Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'supplier-settlement-'
const BOOK_MONEY_URL = '/api/book/money'
const PAYMENTS_URL = '/api/book/money/supplier-payments'
const SUPPLIER = 'Sydenhams'

let app: FastifyInstance
let ownerId: string
let otherOwnerId: string

let startedJobId: string
let planningJobId: string
let finishedJobId: string
let archivedJobId: string
let otherUserJobId: string

// Sydenhams costs: £50 + £100 on the started job, £200 on the planning job,
// £500 on the finished job. Everything else is an exclusion fixture.
let timberId: string // started, 50
let plasterboardId: string // started, 100
let insulationId: string // planning, 200
let blocksId: string // finished, 500
let otherSupplierId: string // Travis Perkins, 300
let supplierNeededId: string
let missingPriceId: string
let zeroCostId: string
let alreadyPaidId: string
let labourId: string
let genericCostId: string
let archivedJobItemId: string
let otherUserItemId: string

let sydenhamsGroupId: string

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((u) => u.id)
  if (!userIds.length) return
  await cleanupJobsOf(userIds)
  await prisma.supplierAccountPayment.deleteMany({ where: { ownerUserId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function cleanupJobsOf(userIds: string[]) {
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((j) => j.id)
  if (jobIds.length) {
    await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobPayment.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  }
  await prisma.supplierAccountPayment.deleteMany({ where: { ownerUserId: { in: userIds } } })
}

const authHeaders = (userId: string) => ({ 'x-pilot-user-id': userId })
const jsonHeaders = (userId: string) => ({ ...authHeaders(userId), 'content-type': 'application/json' })

async function job(ownerUserId: string, title: string, status: string, extra: Record<string, unknown> = {}) {
  const created = await prisma.job.create({
    data: { ownerUserId, title, jobType: 'garden_room', status: status as never, ...extra },
  })
  return created.id
}

// Direct-add through the real HTTP write path, so settlement always runs against
// memory the app itself could have created.
async function addItem(jobId: string, userId: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/memory-items`,
    headers: jsonHeaders(userId),
    payload: body,
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json().id
}

function purchase(opts: { materialName: string; supplierName?: string | null; amount?: string | null; happenedAt?: string }) {
  return {
    memoryType: 'ordered_material',
    materialName: opts.materialName,
    quantity: '10',
    unit: 'sheets',
    ...(opts.supplierName !== undefined ? { supplierName: opts.supplierName } : {}),
    ...(opts.amount != null ? { costAmount: opts.amount, costCurrency: 'GBP', costQualifier: 'total' } : {}),
    happenedAt: opts.happenedAt ?? '2026-07-01',
  }
}

async function bookMoney(userId = ownerId) {
  const res = await app.inject({ method: 'GET', url: BOOK_MONEY_URL, headers: authHeaders(userId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

async function jobMoney(jobId: string, userId = ownerId) {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/money`, headers: authHeaders(userId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

async function budgetSummary(jobId: string, userId = ownerId) {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/budget-summary`, headers: authHeaders(userId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

// Budget must be identical across settlement and Undo apart from the payment
// state it is allowed to reflect (and read timestamps). Everything else — known
// cost, allowance, remaining, categories, rows — is compared literally.
const BUDGET_VOLATILE_KEYS = new Set([
  'generatedAt', 'createdAt', 'updatedAt',
  'isPaid', 'paymentState', 'paidMoneyEventId', 'paidAt', 'allKnownCostsPaid',
  'paidAmount', 'paidCurrency', 'paidLabel',
  'notPaidAmount', 'notPaidCurrency', 'notPaidLabel',
])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !BUDGET_VOLATILE_KEYS.has(key))
        .map(([key, v]) => [key, stripVolatile(v)]),
    )
  }
  return value
}

async function budgetFingerprints() {
  const jobIds = [startedJobId, planningJobId, finishedJobId]
  const summaries = await Promise.all(jobIds.map((id) => budgetSummary(id)))
  return summaries.map(stripVolatile)
}

let requestSeq = 0
const nextRequestId = () => `req-${Date.now()}-${requestSeq++}`

async function settle(
  sourceMemoryItemIds: string[],
  overrides: Record<string, unknown> = {},
  userId = ownerId,
) {
  return app.inject({
    method: 'POST',
    url: PAYMENTS_URL,
    headers: jsonHeaders(userId),
    payload: {
      supplierGroupId: sydenhamsGroupId,
      supplierName: SUPPLIER,
      sourceMemoryItemIds,
      clientRequestId: nextRequestId(),
      ...overrides,
    },
  })
}

async function settleOk(sourceMemoryItemIds: string[], overrides: Record<string, unknown> = {}) {
  const res = await settle(sourceMemoryItemIds, overrides)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

// ── Fixture ───────────────────────────────────────────────────────────────────

async function seedBook() {
  startedJobId = await job(ownerId, 'Mark fence', 'STARTED', { customerTotalAmount: '4000', customerTotalCurrency: 'GBP' })
  planningJobId = await job(ownerId, 'Poole garden room', 'PLANNING')
  finishedJobId = await job(ownerId, 'Broadstone extension', 'FINISHED')
  archivedJobId = await job(ownerId, 'Old archived job', 'ARCHIVED')
  otherUserJobId = await job(otherOwnerId, 'Other builder job', 'STARTED')

  timberId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Timber', supplierName: SUPPLIER, amount: '50', happenedAt: '2026-06-01' }))
  plasterboardId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Plasterboard', supplierName: SUPPLIER, amount: '100', happenedAt: '2026-07-01' }))
  insulationId = await addItem(planningJobId, ownerId, purchase({ materialName: 'Insulation', supplierName: SUPPLIER, amount: '200', happenedAt: '2026-07-05' }))
  blocksId = await addItem(finishedJobId, ownerId, purchase({ materialName: 'Blocks', supplierName: SUPPLIER, amount: '500', happenedAt: '2026-07-06' }))

  // Exclusions.
  otherSupplierId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Bricks', supplierName: 'Travis Perkins', amount: '300' }))
  supplierNeededId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Sand', supplierName: null, amount: '40' }))
  missingPriceId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Fixings', supplierName: SUPPLIER, amount: null }))
  zeroCostId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Free offcuts', supplierName: SUPPLIER, amount: '0' }))
  alreadyPaidId = await addItem(startedJobId, ownerId, purchase({ materialName: 'Paid tiles', supplierName: SUPPLIER, amount: '999' }))
  const paid = await app.inject({
    method: 'POST',
    url: `/api/jobs/${startedJobId}/money/out`,
    headers: jsonHeaders(ownerId),
    payload: { sourceMemoryItemId: alreadyPaidId },
  })
  expect(paid.statusCode, JSON.stringify(paid.json())).toBe(200)

  labourId = await addItem(startedJobId, ownerId, {
    memoryType: 'labour', labourPerson: 'Dave', labourTask: 'Framing', labourHours: '8',
    costAmount: '300', costCurrency: 'GBP', costQualifier: 'total',
  })
  genericCostId = await addItem(startedJobId, ownerId, {
    memoryType: 'budget_cost', summary: 'Digger hire', supplierName: SUPPLIER,
    costAmount: '400', costCurrency: 'GBP', costQualifier: 'total',
  })
  archivedJobItemId = await addItem(archivedJobId, ownerId, purchase({ materialName: 'Archived timber', supplierName: SUPPLIER, amount: '1000' }))
  otherUserItemId = await addItem(otherUserJobId, otherOwnerId, purchase({ materialName: 'Other timber', supplierName: SUPPLIER, amount: '7000' }))

  const body = await bookMoney()
  sydenhamsGroupId = body.toPayOnAccounts.supplierGroups.find(
    (g: { displayName: string }) => g.displayName === SUPPLIER,
  ).groupId
}

beforeAll(async () => {
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Mike', role: 'PILOT' } })).id
  otherOwnerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}other@test.local`, name: 'Other', role: 'PILOT' } })).id
})

afterAll(async () => {
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  delete process.env.PILOT_USER_ID
  await cleanupJobsOf([ownerId, otherOwnerId])
  await seedBook()
})

// ── Recording one payment ─────────────────────────────────────────────────────

describe('POST /api/book/money/supplier-payments', () => {
  it('records one aggregate payment across three jobs and derives the amount from the sources', async () => {
    const receipt = await settleOk([timberId, plasterboardId, insulationId, blocksId], { paidAt: '2026-08-14' })

    expect(receipt.supplierName).toBe(SUPPLIER)
    expect(receipt.totalAmount).toBe('850')
    expect(receipt.totalLabel).toBe('£850')
    expect(receipt.currency).toBe('GBP')
    expect(receipt.costCount).toBe(4)
    expect(receipt.jobCount).toBe(3)
    expect(receipt.budgetsUnchanged).toBe(true)
    expect(receipt.isDeleted).toBe(false)
    expect(receipt.canUndo).toBe(true)
    expect(receipt.canChangeDate).toBe(true)
    expect(receipt.paidAtLabel).toBe('14 Aug 2026')

    // Per-job allocations sum to the payment total, and no job is charged the
    // whole payment.
    const byJob = Object.fromEntries(
      receipt.allocations.map((a: { jobId: string; amount: string }) => [a.jobId, a.amount]),
    )
    expect(byJob[startedJobId]).toBe('150')
    expect(byJob[planningJobId]).toBe('200')
    expect(byJob[finishedJobId]).toBe('500')
    const allocationSum = receipt.allocations.reduce(
      (sum: number, a: { amount: string }) => sum + parseFloat(a.amount), 0,
    )
    expect(String(allocationSum)).toBe(receipt.totalAmount)

    // A finished job takes its allocation without any status change.
    const finished = receipt.allocations.find((a: { jobId: string }) => a.jobId === finishedJobId)
    expect(finished.jobStatus).toBe('finished')
    expect(finished.jobStatusLabel).toBe('Finished')
    expect(finished.amountLabel).toBe('-£500')
    expect((await prisma.job.findUnique({ where: { id: finishedJobId } }))!.status).toBe('FINISHED')

    // Source lines carry what the payment covered on that job.
    const started = receipt.allocations.find((a: { jobId: string }) => a.jobId === startedJobId)
    expect(started.sourceLines.map((l: { itemLabel: string }) => l.itemLabel)).toEqual(['Timber', 'Plasterboard'])
    expect(started.sourceLines[0]).toMatchObject({
      sourceMemoryItemId: timberId,
      amount: '50',
      amountLabel: '£50',
      quantityLabel: '10 sheets',
      sourceDateLabel: '1 Jun 2026',
    })
  })

  it('defaults paidAt to now and rejects a future payment date', async () => {
    const before = Date.now()
    const receipt = await settleOk([timberId])
    expect(new Date(receipt.paidAt).getTime()).toBeGreaterThanOrEqual(before - 1000)

    const future = await settle([plasterboardId], { paidAt: '2099-01-01' })
    expect(future.statusCode).toBe(400)
    expect(future.json().code).toBe('INVALID_FIELD')
  })

  it('is idempotent for a repeated clientRequestId and never writes a second payment', async () => {
    const clientRequestId = nextRequestId()
    const first = await settle([timberId, insulationId], { clientRequestId })
    expect(first.statusCode).toBe(201)

    const retry = await settle([timberId, insulationId], { clientRequestId })
    // 200, not 201: nothing new was recorded.
    expect(retry.statusCode).toBe(200)
    expect(retry.json().id).toBe(first.json().id)
    expect(retry.json().totalAmount).toBe('250')

    expect(await prisma.supplierAccountPayment.count({ where: { ownerUserId: ownerId } })).toBe(1)
    expect(await prisma.jobMoneyEvent.count({
      where: { supplierAccountPaymentId: first.json().id, isDeleted: false },
    })).toBe(2)
  })

  it('rejects a stale selection with a different request id and writes nothing', async () => {
    await settleOk([timberId, insulationId])
    const beforeEvents = await prisma.jobMoneyEvent.count({ where: { isDeleted: false } })

    // Same costs, new submit: they are already paid.
    const duplicate = await settle([timberId, insulationId])
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().code).toBe('SUPPLIER_PAYMENT_STALE_SELECTION')

    // A selection mixing one still-payable cost with one already-paid cost is
    // rejected whole — no partial payment.
    const partial = await settle([plasterboardId, timberId])
    expect(partial.statusCode).toBe(409)

    expect(await prisma.supplierAccountPayment.count({ where: { ownerUserId: ownerId } })).toBe(1)
    expect(await prisma.jobMoneyEvent.count({ where: { isDeleted: false } })).toBe(beforeEvents)
    // The still-payable cost stayed unpaid and settleable.
    const retry = await settle([plasterboardId])
    expect(retry.statusCode).toBe(201)
  })
})

// ── Eligibility ───────────────────────────────────────────────────────────────

describe('settlement eligibility', () => {
  it('refuses a Supplier needed settlement', async () => {
    const body = await bookMoney()
    const needed = body.toPayOnAccounts.supplierGroups.find((g: { kind: string }) => g.kind === 'supplier_needed')
    const res = await settle([supplierNeededId], {
      supplierGroupId: needed.groupId,
      supplierName: 'Supplier needed',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
  })

  it.each([
    ['a cost with no price', () => missingPriceId],
    ['a trusted £0 cost', () => zeroCostId],
    ['a cost already marked paid on its own', () => alreadyPaidId],
    ['labour', () => labourId],
    ['a generic budget cost that cannot be tied to the account', () => genericCostId],
    ['a cost on an archived job', () => archivedJobItemId],
    ["another builder's cost", () => otherUserItemId],
    ['a cost that belongs to another supplier', () => otherSupplierId],
    ['a cost with no supplier named', () => supplierNeededId],
  ])('cannot settle %s', async (_label, id) => {
    const res = await settle([timberId, id()])
    expect(res.statusCode, JSON.stringify(res.json())).toBe(409)
    expect(res.json().code).toBe('SUPPLIER_PAYMENT_STALE_SELECTION')
    // Nothing partial: the eligible cost in the same selection stays unpaid.
    expect(await prisma.jobMoneyEvent.count({ where: { sourceMemoryItemId: timberId, isDeleted: false } })).toBe(0)
    expect(await prisma.supplierAccountPayment.count({ where: { ownerUserId: ownerId } })).toBe(0)
  })

  it('rejects an empty selection, a missing request id and a mismatched supplier group', async () => {
    const empty = await settle([])
    expect(empty.statusCode).toBe(400)

    const noRequestId = await settle([timberId], { clientRequestId: undefined })
    expect(noRequestId.statusCode).toBe(400)
    expect(noRequestId.json().code).toBe('MISSING_FIELD')

    const wrongGroup = await settle([timberId], { supplierGroupId: 'not-this-account' })
    expect(wrongGroup.statusCode).toBe(400)
    expect(wrongGroup.json().code).toBe('INVALID_FIELD')

    // The group id is derived per user, so another builder's group id is no key.
    const otherBook = await bookMoney(otherOwnerId)
    const otherGroupId = otherBook.toPayOnAccounts.supplierGroups[0].groupId
    const crossUserGroup = await settle([timberId], { supplierGroupId: otherGroupId })
    expect(crossUserGroup.statusCode).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: PAYMENTS_URL, payload: {} })
    expect(res.statusCode).toBe(401)
  })
})

// ── What settlement moves, and what it must not ───────────────────────────────

describe('settlement effects on the read models', () => {
  it('reduces the supplier account and adds one history row without touching Budget', async () => {
    const budgetBefore = await budgetFingerprints()
    const before = await bookMoney()
    expect(before.toPayOnAccounts.totalAmount).toBe('1190') // 850 Sydenhams + 300 TP + 40 unnamed
    expect(before.accountPaymentHistory).toEqual([])

    const receipt = await settleOk([timberId, plasterboardId, insulationId, blocksId], { paidAt: '2026-08-14' })

    const after = await bookMoney()
    // The settled costs have left the account; the other supplier is untouched.
    expect(after.toPayOnAccounts.totalAmount).toBe('340')
    expect(after.toPayOnAccounts.supplierGroups.map((g: { displayName: string }) => g.displayName))
      .toEqual(['Travis Perkins', 'Supplier needed'])
    expect(after.accountPaymentHistory).toEqual([
      {
        id: receipt.id,
        supplierName: SUPPLIER,
        paidAt: receipt.paidAt,
        paidAtLabel: '14 Aug 2026',
        totalAmount: '850',
        currency: 'GBP',
        totalLabel: '£850',
        costCount: 4,
        jobCount: 3,
      },
    ])

    expect(await budgetFingerprints()).toEqual(budgetBefore)
  })

  it('keeps the receipt readable after the supplier has no costs left unpaid', async () => {
    const receipt = await settleOk([timberId, plasterboardId, insulationId, blocksId])

    const after = await bookMoney()
    // Sydenhams is gone from the current account list (its unpriced cost is a
    // correction prompt, not a payable balance)…
    expect(after.toPayOnAccounts.supplierGroups.some((g: { displayName: string }) => g.displayName === SUPPLIER)).toBe(false)
    // …but the payment is still reachable through history, and the receipt reads.
    expect(after.accountPaymentHistory[0].id).toBe(receipt.id)

    const res = await app.inject({ method: 'GET', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(receipt)
  })

  it('shows one Money-out allocation row per affected job and never double-counts', async () => {
    const receipt = await settleOk([timberId, plasterboardId, insulationId], { paidAt: '2026-08-14' })

    const started = await jobMoney(startedJobId)
    const allocations = started.rows.filter((r: { kind: string }) => r.kind === 'supplier_account_payment')
    expect(allocations).toHaveLength(1)
    expect(allocations[0]).toMatchObject({
      id: receipt.id,
      supplierAccountPaymentId: receipt.id,
      supplierName: SUPPLIER,
      direction: 'out',
      amount: '150',
      amountLabel: '-£150',
      removable: false,
      editable: false,
    })
    expect(allocations[0].sourceMemoryItemIds.sort()).toEqual([timberId, plasterboardId].sort())
    expect(allocations[0].allocationSourceLabels.sort()).toEqual(['Plasterboard', 'Timber'])
    expect(new Date(allocations[0].occurredAt).toISOString()).toBe(receipt.paidAt)

    // The child paid markers exist for paid-state, but never as their own rows.
    const rowIds = started.rows.map((r: { id: string }) => r.id)
    const childEvents = await prisma.jobMoneyEvent.findMany({
      where: { supplierAccountPaymentId: receipt.id, jobId: startedJobId },
      select: { id: true },
    })
    expect(childEvents).toHaveLength(2)
    for (const child of childEvents) expect(rowIds).not.toContain(child.id)

    // Money out counts the allocation once: 150 here + the 999 paid separately.
    expect(started.moneyOutAmount).toBe('1149')

    const planning = await jobMoney(planningJobId)
    expect(planning.rows.filter((r: { kind: string }) => r.kind === 'supplier_account_payment')).toHaveLength(1)
    expect(planning.moneyOutAmount).toBe('200')

    // A job with no covered cost sees nothing.
    const finished = await jobMoney(finishedJobId)
    expect(finished.rows).toHaveLength(0)
  })

  it('marks the covered costs paid in Budget without changing any Budget figure', async () => {
    const budgetBefore = await budgetSummary(startedJobId)
    await settleOk([timberId, plasterboardId])
    const budgetAfter = await budgetSummary(startedJobId)

    expect(stripVolatile(budgetAfter)).toEqual(stripVolatile(budgetBefore))
    // Paid state is the one thing that may move, and it did.
    expect(JSON.stringify(budgetAfter)).not.toEqual(JSON.stringify(budgetBefore))
  })
})

// ── Receipt, date change, Undo ────────────────────────────────────────────────

describe('receipt access', () => {
  it('hides a receipt from another builder and 404s an unknown id', async () => {
    const receipt = await settleOk([timberId])

    const other = await app.inject({ method: 'GET', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(otherOwnerId) })
    expect(other.statusCode).toBe(404)
    expect(other.json().code).toBe('SUPPLIER_PAYMENT_NOT_FOUND')

    const unknown = await app.inject({
      method: 'GET',
      url: `${PAYMENTS_URL}/00000000-0000-0000-0000-0000000000ff`,
      headers: authHeaders(ownerId),
    })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('PATCH /api/book/money/supplier-payments/:paymentId', () => {
  it('changes only the payment date, on the receipt and the job allocations', async () => {
    const receipt = await settleOk([timberId, insulationId], { paidAt: '2026-08-10' })

    const res = await app.inject({
      method: 'PATCH',
      url: `${PAYMENTS_URL}/${receipt.id}`,
      headers: jsonHeaders(ownerId),
      payload: { paidAt: '2026-08-01' },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    const patched = res.json()

    expect(patched.paidAtLabel).toBe('1 Aug 2026')
    expect(patched.paidAt).not.toBe(receipt.paidAt)
    // Everything else about the payment is identical.
    expect({ ...patched, paidAt: null, paidAtLabel: null })
      .toEqual({ ...receipt, paidAt: null, paidAtLabel: null })

    const started = await jobMoney(startedJobId)
    const allocation = started.rows.find((r: { kind: string }) => r.kind === 'supplier_account_payment')
    expect(new Date(allocation.occurredAt).toISOString()).toBe(patched.paidAt)
    expect(allocation.amount).toBe('50')

    const history = (await bookMoney()).accountPaymentHistory[0]
    expect(history.paidAtLabel).toBe('1 Aug 2026')
    expect(history.totalAmount).toBe('250')
  })

  it('rejects a future date and refuses to touch anything but the date', async () => {
    const receipt = await settleOk([timberId])
    const budgetBefore = await budgetFingerprints()

    const future = await app.inject({
      method: 'PATCH',
      url: `${PAYMENTS_URL}/${receipt.id}`,
      headers: jsonHeaders(ownerId),
      payload: { paidAt: '2099-01-01' },
    })
    expect(future.statusCode).toBe(400)

    // Amount/supplier/selection fields sent alongside are ignored, not applied.
    const res = await app.inject({
      method: 'PATCH',
      url: `${PAYMENTS_URL}/${receipt.id}`,
      headers: jsonHeaders(ownerId),
      payload: { paidAt: '2026-08-02', totalAmount: '9999', supplierName: 'Someone else', sourceMemoryItemIds: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().totalAmount).toBe('50')
    expect(res.json().supplierName).toBe(SUPPLIER)
    expect(res.json().costCount).toBe(1)
    expect(await budgetFingerprints()).toEqual(budgetBefore)
  })
})

describe('DELETE /api/book/money/supplier-payments/:paymentId', () => {
  it('undoes the whole payment, restores every covered cost and leaves Budget unchanged', async () => {
    const budgetBefore = await budgetFingerprints()
    const bookBefore = await bookMoney()

    const receipt = await settleOk([timberId, plasterboardId, insulationId, blocksId])

    const res = await app.inject({
      method: 'DELETE',
      url: `${PAYMENTS_URL}/${receipt.id}`,
      headers: authHeaders(ownerId),
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    const undone = res.json()
    expect(undone.isDeleted).toBe(true)
    expect(undone.canUndo).toBe(false)
    expect(undone.canChangeDate).toBe(false)
    // The receipt still says what the payment had covered.
    expect(undone.totalAmount).toBe('850')
    expect(undone.costCount).toBe(4)

    // Every covered cost is payable again and the account total is back.
    const bookAfter = await bookMoney()
    expect(bookAfter.toPayOnAccounts.totalAmount).toBe(bookBefore.toPayOnAccounts.totalAmount)
    expect(bookAfter.accountPaymentHistory).toEqual([])
    expect(await budgetFingerprints()).toEqual(budgetBefore)

    // No active allocation is left on any job.
    for (const jobId of [startedJobId, planningJobId, finishedJobId]) {
      const money = await jobMoney(jobId)
      expect(money.rows.filter((r: { kind: string }) => r.kind === 'supplier_account_payment')).toHaveLength(0)
    }

    // An undone receipt is gone from the read route, and Undo does not repeat.
    const read = await app.inject({ method: 'GET', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })
    expect(read.statusCode).toBe(404)
    const again = await app.inject({ method: 'DELETE', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })
    expect(again.statusCode).toBe(404)

    // The costs can be settled again afterwards.
    expect((await settle([timberId, plasterboardId])).statusCode).toBe(201)
  })

  it('cannot be undone by another builder', async () => {
    const receipt = await settleOk([timberId])
    const res = await app.inject({ method: 'DELETE', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(otherOwnerId) })
    expect(res.statusCode).toBe(404)
    expect(await prisma.jobMoneyEvent.count({ where: { supplierAccountPaymentId: receipt.id, isDeleted: false } })).toBe(1)
  })
})

// ── Costs an aggregate payment owns ───────────────────────────────────────────

describe('a source cost covered by an active supplier payment', () => {
  it('cannot have its paid state undone on its own', async () => {
    const receipt = await settleOk([timberId, plasterboardId])
    const child = await prisma.jobMoneyEvent.findFirstOrThrow({
      where: { supplierAccountPaymentId: receipt.id, sourceMemoryItemId: timberId },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${startedJobId}/money/events/${child.id}`,
      headers: authHeaders(ownerId),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('SUPPLIER_PAYMENT_OWNS_COST')
    // The frontend is routed to the aggregate receipt rather than left stuck.
    expect(res.json().supplierAccountPaymentId).toBe(receipt.id)

    expect(await prisma.jobMoneyEvent.count({ where: { id: child.id, isDeleted: false } })).toBe(1)
  })

  it('cannot be re-priced or removed, but can still be reworded', async () => {
    const receipt = await settleOk([timberId])

    const repriced = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${startedJobId}/memory-items/${timberId}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', materialName: 'Timber', quantity: '10', unit: 'sheets', supplierName: SUPPLIER, costAmount: '75', costCurrency: 'GBP', costQualifier: 'total' },
    })
    expect(repriced.statusCode).toBe(400)
    expect(repriced.json().code).toBe('SUPPLIER_PAYMENT_OWNS_COST')
    expect(repriced.json().supplierAccountPaymentId).toBe(receipt.id)

    const resupplied = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${startedJobId}/memory-items/${timberId}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', materialName: 'Timber', quantity: '10', unit: 'sheets', supplierName: 'Travis Perkins', costAmount: '50', costCurrency: 'GBP', costQualifier: 'total' },
    })
    expect(resupplied.statusCode).toBe(400)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${startedJobId}/memory-items/${timberId}`,
      headers: authHeaders(ownerId),
    })
    expect(removed.statusCode).toBe(400)
    expect(removed.json().code).toBe('SUPPLIER_PAYMENT_OWNS_COST')

    // Wording is not financially material, so a correction Mike needs still works.
    const reworded = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${startedJobId}/memory-items/${timberId}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', materialName: 'Timber (C24)', quantity: '10', unit: 'sheets', supplierName: SUPPLIER, costAmount: '50', costCurrency: 'GBP', costQualifier: 'total' },
    })
    expect(reworded.statusCode, JSON.stringify(reworded.json())).toBe(200)

    // The receipt still reconciles after the wording change.
    const after = await app.inject({ method: 'GET', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })
    expect(after.json().totalAmount).toBe('50')
    expect(after.json().allocations[0].sourceLines[0].itemLabel).toBe('Timber (C24)')
  })

  it('releases the source once the payment is undone', async () => {
    const receipt = await settleOk([timberId])
    await app.inject({ method: 'DELETE', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${startedJobId}/memory-items/${timberId}`,
      headers: authHeaders(ownerId),
    })
    expect(removed.statusCode).toBe(204)
  })
})
