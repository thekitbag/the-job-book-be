// Source purchase dates on supplier payment receipt lines.
//
// A receipt has two kinds of date and they answer different questions: the
// payment date says when the money left, and each source line's date says when
// that purchase happened. These tests pin that they stay independent, that a
// missing purchase date is reported as missing rather than filled in from
// something nearby, and that correcting a source date later shows up on the
// receipt WITHOUT moving the amount, the allocation, Budget or Money.
//
// This is recognition evidence, so the failure that matters most is a date that
// looks right and isn't. Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'supplier-source-dates-'
const PAYMENTS_URL = '/api/book/money/supplier-payments'
const SUPPLIER = 'Sydenhams'

let app: FastifyInstance
let ownerId: string

let jobAId: string
let jobBId: string

// Two same-supplier Timber purchases on different days — the pair Mike could
// not tell apart before this slice — plus one purchase with no remembered date.
let timberJulyId: string
let timberSeptId: string
let plasterboardId: string
let undatedId: string

let sydenhamsGroupId: string

const authHeaders = (userId: string) => ({ 'x-pilot-user-id': userId })
const jsonHeaders = (userId: string) => ({ ...authHeaders(userId), 'content-type': 'application/json' })

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((u) => u.id)
  if (!userIds.length) return
  await cleanupJobsOf(userIds)
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function cleanupJobsOf(userIds: string[]) {
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.supplierAccountPayment.deleteMany({ where: { ownerUserId: { in: userIds } } })
  if (jobIds.length) {
    await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobPayment.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  }
}

async function job(title: string, status: string) {
  const created = await prisma.job.create({
    data: { ownerUserId: ownerId, title, jobType: 'garden_room', status: status as never },
  })
  return created.id
}

async function addItem(jobId: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/memory-items`,
    headers: jsonHeaders(ownerId),
    payload: body,
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json().id
}

function purchase(opts: { materialName: string; amount: string; happenedAt?: string | null }) {
  return {
    memoryType: 'ordered_material',
    materialName: opts.materialName,
    quantity: '10',
    unit: 'sheets',
    supplierName: SUPPLIER,
    costAmount: opts.amount,
    costCurrency: 'GBP',
    costQualifier: 'total',
    // Omitted entirely, not sent as null, so the item is stored exactly as a
    // note that never mentioned a date would be stored.
    ...(opts.happenedAt ? { happenedAt: opts.happenedAt } : {}),
  }
}

let requestSeq = 0
const nextRequestId = () => `src-dates-${Date.now()}-${requestSeq++}`

async function settle(sourceMemoryItemIds: string[], overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: PAYMENTS_URL,
    headers: jsonHeaders(ownerId),
    payload: {
      supplierGroupId: sydenhamsGroupId,
      supplierName: SUPPLIER,
      sourceMemoryItemIds,
      clientRequestId: nextRequestId(),
      paidAt: '2026-08-10',
      ...overrides,
    },
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

async function readReceipt(paymentId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `${PAYMENTS_URL}/${paymentId}`,
    headers: authHeaders(ownerId),
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

async function bookMoney() {
  const res = await app.inject({ method: 'GET', url: '/api/book/money', headers: authHeaders(ownerId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

interface SourceLine {
  sourceMemoryItemId: string
  itemLabel: string
  amount: string
  amountLabel: string
  sourceDate: string | null
  sourceDateLabel: string
}

// Every source line in the receipt, flattened across allocations.
function allLines(receipt: { allocations: Array<{ sourceLines: SourceLine[] }> }): SourceLine[] {
  return receipt.allocations.flatMap((a) => a.sourceLines)
}

function lineFor(receipt: { allocations: Array<{ sourceLines: SourceLine[] }> }, sourceId: string): SourceLine {
  const line = allLines(receipt).find((l) => l.sourceMemoryItemId === sourceId)
  expect(line, `no source line for ${sourceId}`).toBeDefined()
  return line as SourceLine
}

// The money shape of a receipt: what a date must never move.
function moneyShape(receipt: {
  totalAmount: string
  costCount: number
  allocations: Array<{ jobId: string; amount: string; sourceLines: SourceLine[] }>
}) {
  return {
    totalAmount: receipt.totalAmount,
    costCount: receipt.costCount,
    allocations: receipt.allocations.map((a) => ({
      jobId: a.jobId,
      amount: a.amount,
      lines: a.sourceLines.map((l) => [l.sourceMemoryItemId, l.amount]),
    })),
  }
}

const VOLATILE = new Set(['generatedAt'])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, stripVolatile(v)]),
    )
  }
  return value
}

async function financeSnapshot() {
  const snapshot: Record<string, unknown> = {}
  for (const jobId of [jobAId, jobBId]) {
    for (const view of ['budget-summary', 'money']) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/${view}`, headers: authHeaders(ownerId) })
      expect(res.statusCode).toBe(200)
      snapshot[`${view}:${jobId}`] = stripVolatile(res.json())
    }
  }
  return snapshot
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED = 'true'
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Mike', role: 'PILOT' } })).id
})

afterAll(async () => {
  delete process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  delete process.env.PILOT_USER_ID
  process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED = 'true'
  await cleanupJobsOf([ownerId])

  jobAId = await job('Mark fence', 'STARTED')
  jobBId = await job('Poole garden room', 'PLANNING')

  timberJulyId = await addItem(jobAId, purchase({ materialName: 'Timber', amount: '500', happenedAt: '2026-07-07' }))
  timberSeptId = await addItem(jobAId, purchase({ materialName: 'Timber', amount: '300', happenedAt: '2026-07-09' }))
  plasterboardId = await addItem(jobBId, purchase({ materialName: 'Plasterboard', amount: '120', happenedAt: '2026-06-30' }))
  undatedId = await addItem(jobBId, purchase({ materialName: 'Fixings', amount: '45', happenedAt: null }))

  sydenhamsGroupId = (await bookMoney()).toPayOnAccounts.supplierGroups.find(
    (g: { displayName: string }) => g.displayName === SUPPLIER,
  ).groupId
})

// ── Dates on every line ───────────────────────────────────────────────────────

describe('receipt source lines carry the purchase date', () => {
  it('dates every included line on the creation response', async () => {
    const receipt = await settle([timberJulyId, timberSeptId, plasterboardId])

    expect(allLines(receipt)).toHaveLength(3)
    expect(lineFor(receipt, timberJulyId)).toMatchObject({ sourceDate: expect.stringMatching(/^2026-07-07/), sourceDateLabel: '7 Jul' })
    expect(lineFor(receipt, timberSeptId)).toMatchObject({ sourceDate: expect.stringMatching(/^2026-07-09/), sourceDateLabel: '9 Jul' })
    expect(lineFor(receipt, plasterboardId)).toMatchObject({ sourceDate: expect.stringMatching(/^2026-06-30/), sourceDateLabel: '30 Jun' })
  })

  it('shows the same dates when the receipt is reopened from history', async () => {
    const created = await settle([timberJulyId, timberSeptId, plasterboardId])

    const history = (await bookMoney()).accountPaymentHistory
    expect(history.map((h: { id: string }) => h.id)).toContain(created.id)

    const reopened = await readReceipt(created.id)
    expect(allLines(reopened).map((l) => [l.sourceMemoryItemId, l.sourceDate, l.sourceDateLabel]))
      .toEqual(allLines(created).map((l) => [l.sourceMemoryItemId, l.sourceDate, l.sourceDateLabel]))
    expect(lineFor(reopened, timberJulyId).sourceDateLabel).toBe('7 Jul')
  })

  it('tells two same-supplier purchases of the same material apart by date', async () => {
    const receipt = await settle([timberJulyId, timberSeptId])

    const timberLines = allLines(receipt).filter((l) => l.itemLabel === 'Timber')
    expect(timberLines).toHaveLength(2)
    // Same supplier, same item wording, same job — the date and amount are the
    // only things that separate them, and they must both be right.
    expect(timberLines.map((l) => [l.sourceDateLabel, l.amountLabel])).toEqual([
      ['7 Jul', '£500'],
      ['9 Jul', '£300'],
    ])
    expect(new Set(timberLines.map((l) => l.sourceMemoryItemId)).size).toBe(2)
  })

  it('keeps the payment date and the source dates as separate fields', async () => {
    const receipt = await settle([timberJulyId], { paidAt: '2026-08-10' })

    expect(receipt.paidAtLabel).toBe('10 Aug 2026')
    const line = lineFor(receipt, timberJulyId)
    expect(line.sourceDateLabel).toBe('7 Jul')
    expect(line.sourceDate).not.toBe(receipt.paidAt)
    // Nothing on a source line claims the line itself was paid on a date.
    expect(JSON.stringify(line)).not.toMatch(/paid/i)
  })
})

// ── Missing source date ───────────────────────────────────────────────────────

describe('a purchase with no remembered date', () => {
  it('says the date is not recorded rather than sending nothing to display', async () => {
    const receipt = await settle([timberJulyId, undatedId])

    expect(lineFor(receipt, undatedId)).toMatchObject({
      sourceDate: null,
      sourceDateLabel: 'Date not recorded',
      // The rest of the line is unaffected: a missing date is not a missing cost.
      amount: '45',
      amountLabel: '£45',
      itemLabel: 'Fixings',
    })
  })

  it('never fills the gap from the payment date, the record date or today', async () => {
    const paidAt = '2026-08-10'
    const receipt = await settle([undatedId], { paidAt })
    const line = lineFor(receipt, undatedId)

    expect(line.sourceDate).toBeNull()
    // The three tempting fallbacks, each ruled out explicitly.
    expect(line.sourceDateLabel).not.toBe(receipt.paidAtLabel)
    expect(line.sourceDateLabel).not.toMatch(/Aug/)

    const stored = await prisma.memoryItem.findUniqueOrThrow({ where: { id: undatedId } })
    expect(stored.happenedAt).toBeNull()
    const createdLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' })
      .format(stored.createdAt)
    expect(line.sourceDateLabel).not.toBe(createdLabel)
  })

  it('still orders the undated line stably among dated ones', async () => {
    const first = await settle([timberJulyId, timberSeptId, plasterboardId, undatedId])
    const order = allLines(first).map((l) => l.sourceMemoryItemId)
    expect(new Set(order).size).toBe(4)
    expect(allLines(await readReceipt(first.id)).map((l) => l.sourceMemoryItemId)).toEqual(order)
  })
})

// ── Payment date vs source dates ──────────────────────────────────────────────

describe('changing the payment date', () => {
  it('moves the payment date only, leaving every source date where it was', async () => {
    const created = await settle([timberJulyId, timberSeptId, undatedId], { paidAt: '2026-08-10' })
    const sourceDatesBefore = allLines(created).map((l) => [l.sourceMemoryItemId, l.sourceDate, l.sourceDateLabel])
    const moneyBefore = moneyShape(created)

    const res = await app.inject({
      method: 'PATCH',
      url: `${PAYMENTS_URL}/${created.id}`,
      headers: jsonHeaders(ownerId),
      payload: { paidAt: '2026-08-14' },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    const patched = res.json()

    expect(patched.paidAtLabel).toBe('14 Aug 2026')
    expect(patched.paidAtLabel).not.toBe(created.paidAtLabel)
    expect(allLines(patched).map((l) => [l.sourceMemoryItemId, l.sourceDate, l.sourceDateLabel])).toEqual(sourceDatesBefore)
    expect(moneyShape(patched)).toEqual(moneyBefore)

    // And on a fresh read, not just in the PATCH response.
    const reopened = await readReceipt(created.id)
    expect(allLines(reopened).map((l) => [l.sourceMemoryItemId, l.sourceDate, l.sourceDateLabel])).toEqual(sourceDatesBefore)
  })
})

// ── Correcting a source date ──────────────────────────────────────────────────

describe('correcting a source purchase date', () => {
  async function correctDate(jobId: string, memoryItemId: string, happenedAt: string) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/memory-items/${memoryItemId}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', happenedAt },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    return res.json()
  }

  it('shows the corrected date on the next receipt read', async () => {
    const created = await settle([timberJulyId, timberSeptId])
    expect(lineFor(created, timberJulyId).sourceDateLabel).toBe('7 Jul')

    await correctDate(jobAId, timberJulyId, '2026-07-02')

    const reopened = await readReceipt(created.id)
    expect(lineFor(reopened, timberJulyId)).toMatchObject({
      sourceDate: expect.stringMatching(/^2026-07-02/),
      sourceDateLabel: '2 Jul',
    })
    // The line Mike did not correct is untouched.
    expect(lineFor(reopened, timberSeptId).sourceDateLabel).toBe('9 Jul')
  })

  it('gives an undated line a date once one is remembered', async () => {
    const created = await settle([undatedId])
    expect(lineFor(created, undatedId).sourceDateLabel).toBe('Date not recorded')

    await correctDate(jobBId, undatedId, '2026-07-15')

    expect(lineFor(await readReceipt(created.id), undatedId)).toMatchObject({
      sourceDate: expect.stringMatching(/^2026-07-15/),
      sourceDateLabel: '15 Jul',
    })
  })

  it('changes nothing about the payment, its amount, its membership or its allocations', async () => {
    const created = await settle([timberJulyId, timberSeptId, plasterboardId], { paidAt: '2026-08-10' })
    const before = {
      money: moneyShape(created),
      paidAt: created.paidAt,
      paidAtLabel: created.paidAtLabel,
      supplierName: created.supplierName,
      totalLabel: created.totalLabel,
      jobCount: created.jobCount,
      canUndo: created.canUndo,
    }

    await correctDate(jobAId, timberJulyId, '2026-07-02')

    const after = await readReceipt(created.id)
    expect(moneyShape(after)).toEqual(before.money)
    expect(after.paidAt).toBe(before.paidAt)
    expect(after.paidAtLabel).toBe(before.paidAtLabel)
    expect(after.supplierName).toBe(before.supplierName)
    expect(after.totalLabel).toBe(before.totalLabel)
    expect(after.jobCount).toBe(before.jobCount)
    expect(after.canUndo).toBe(before.canUndo)
    // Paid state is untouched: the covered costs are still off the account list.
    const account = (await bookMoney()).toPayOnAccounts
    const stillUnpaid = account?.supplierGroups.flatMap((g: { lines: Array<{ sourceMemoryItemId: string }> }) => g.lines) ?? []
    expect(stillUnpaid.map((l: { sourceMemoryItemId: string }) => l.sourceMemoryItemId)).not.toContain(timberJulyId)
  })

  it('leaves Budget and Money totals exactly as they were', async () => {
    await settle([timberJulyId, timberSeptId, plasterboardId], { paidAt: '2026-08-10' })
    const before = await financeSnapshot()

    await correctDate(jobAId, timberJulyId, '2026-07-02')

    expect(await financeSnapshot()).toEqual(before)
  })

  it('still allows the complete Undo afterwards', async () => {
    const created = await settle([timberJulyId, timberSeptId, plasterboardId])
    await correctDate(jobAId, timberJulyId, '2026-07-02')

    const res = await app.inject({
      method: 'DELETE',
      url: `${PAYMENTS_URL}/${created.id}`,
      headers: authHeaders(ownerId),
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    const undone = res.json()
    expect(undone.isDeleted).toBe(true)
    // The undone receipt still reads, and still carries the corrected date.
    expect(lineFor(undone, timberJulyId).sourceDateLabel).toBe('2 Jul')

    // Every covered cost is back on the account as unpaid.
    const account = (await bookMoney()).toPayOnAccounts
    const unpaidIds = account.supplierGroups.flatMap((g: { lines: Array<{ sourceMemoryItemId: string }> }) =>
      g.lines.map((l) => l.sourceMemoryItemId),
    )
    for (const id of [timberJulyId, timberSeptId, plasterboardId]) expect(unpaidIds).toContain(id)
    expect(await prisma.jobMoneyEvent.count({
      where: { supplierAccountPaymentId: created.id, isDeleted: false },
    })).toBe(0)
  })
})
