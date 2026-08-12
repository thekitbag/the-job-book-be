// Cross-job Money (GET /api/book/money): the read-only index over money facts
// that already live on jobs. These tests pin the trust boundary (what counts as
// a supplier-account cost), the exclusions, the Book Home ↔ overview agreement,
// and that source corrections move the read model without creating records.
// Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'cross-job-money-'
const BOOK_MONEY_URL = '/api/book/money'

let app: FastifyInstance
let ownerId: string
let otherOwnerId: string

// Jobs seeded fresh for every test (see seedBook).
let startedJobId: string
let planningJobId: string
let finishedJobId: string
let archivedJobId: string
let overpaidJobId: string
let otherUserJobId: string

// Item ids the mutation tests act on.
let sydenhamsSmallItemId: string
let noSupplierItemId: string
let missingPriceItemId: string

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
  if (!jobIds.length) return
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobPayment.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
}

// ── Request helpers ───────────────────────────────────────────────────────────

const authHeaders = (userId: string) => ({ 'x-pilot-user-id': userId })
const jsonHeaders = (userId: string) => ({ ...authHeaders(userId), 'content-type': 'application/json' })

async function bookMoney(userId = ownerId) {
  const res = await app.inject({ method: 'GET', url: BOOK_MONEY_URL, headers: authHeaders(userId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

function groupNamed(body: { toPayOnAccounts: { supplierGroups: Array<{ displayName: string }> } | null }, displayName: string) {
  return body.toPayOnAccounts?.supplierGroups.find((g) => g.displayName === displayName)
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function job(ownerUserId: string, title: string, status: string, extra: Record<string, unknown> = {}) {
  const created = await prisma.job.create({
    data: { ownerUserId, title, jobType: 'garden_room', status: status as never, ...extra },
  })
  return created.id
}

// Direct-add through the real HTTP write path, so the read model is always
// exercised against memory the app itself could have created.
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

// A bought/ordered material purchase with a trusted stated total.
function purchase(opts: {
  materialName: string
  supplierName?: string | null
  amount?: string | null
  happenedAt?: string
  quantity?: string
  unit?: string
}) {
  return {
    memoryType: 'ordered_material',
    materialName: opts.materialName,
    quantity: opts.quantity ?? '10',
    unit: opts.unit ?? 'sheets',
    ...(opts.supplierName !== undefined ? { supplierName: opts.supplierName } : {}),
    ...(opts.amount != null ? { costAmount: opts.amount, costCurrency: 'GBP', costQualifier: 'total' } : {}),
    happenedAt: opts.happenedAt ?? '2026-07-01',
  }
}

// Rows the validated write paths deliberately cannot produce (non-GBP price,
// unresolved cost flag) still have to be handled by the read model.
async function rawItem(jobId: string, userId: string, data: Record<string, unknown>) {
  const decision = await prisma.reviewDecision.create({
    data: { jobId, decidedBy: userId, action: 'ADD_MISSING', sourceCandidateFactIds: [] },
  })
  const item = await prisma.memoryItem.create({
    data: {
      jobId,
      reviewDecisionId: decision.id,
      isManual: true,
      memoryType: 'ORDERED_MATERIAL',
      summary: 'Raw seeded item',
      ...data,
    } as never,
  })
  return item.id
}

async function markPaid(jobId: string, memoryItemId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/money/out`,
    headers: jsonHeaders(ownerId),
    payload: { sourceMemoryItemId: memoryItemId },
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

// The whole fixture: one realistic supplier account spread over several jobs,
// plus every category of row that must be excluded.
async function seedBook() {
  startedJobId = await job(ownerId, 'Mark fence', 'STARTED', {
    roughLocationOrLabel: 'Wimborne', customerTotalAmount: '4000', customerTotalCurrency: 'GBP',
  })
  planningJobId = await job(ownerId, 'Poole garden room', 'PLANNING', {
    customerTotalAmount: '1000', customerTotalCurrency: 'GBP',
  })
  finishedJobId = await job(ownerId, 'Broadstone extension', 'FINISHED', {
    customerTotalAmount: '2000', customerTotalCurrency: 'GBP',
  })
  archivedJobId = await job(ownerId, 'Old archived job', 'ARCHIVED')
  overpaidJobId = await job(ownerId, 'Overpaid job', 'STARTED', {
    customerTotalAmount: '800', customerTotalCurrency: 'GBP',
  })
  // A started job with no trusted customer total: never appears in Owed to me.
  await job(ownerId, 'No customer total job', 'STARTED')
  otherUserJobId = await job(otherOwnerId, 'Other builder job', 'STARTED', {
    customerTotalAmount: '9000', customerTotalCurrency: 'GBP',
  })

  // Sydenhams: £150 on the started job (two purchases), £200 on the planning job.
  sydenhamsSmallItemId = await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Timber', supplierName: 'Sydenhams', amount: '50', happenedAt: '2026-06-01' }))
  await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Plasterboard', supplierName: 'Sydenhams', amount: '100', happenedAt: '2026-07-01' }))
  await addItem(planningJobId, ownerId,
    purchase({ materialName: 'Insulation', supplierName: 'Sydenhams', amount: '200', happenedAt: '2026-07-05' }))
  // A near-identical supplier name must remain its own account.
  await addItem(planningJobId, ownerId,
    purchase({ materialName: 'Screws', supplierName: "Sydenham's", amount: '10' }))
  // Finished job costs stay eligible while unpaid.
  await addItem(finishedJobId, ownerId,
    purchase({ materialName: 'Blocks', supplierName: 'Travis Perkins', amount: '500' }))
  // Eligible priced cost with no supplier → Supplier needed.
  noSupplierItemId = await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Sand', supplierName: null, amount: '40' }))

  // Missing price, supplier known → missing-price block only.
  missingPriceItemId = await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Fixings', supplierName: 'Jewson', amount: null }))
  // Missing price AND missing supplier → shown once, in missing price only.
  await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Membrane', supplierName: null, amount: null }))

  // Exclusions.
  const paidItemId = await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Paid tiles', supplierName: 'Sydenhams', amount: '999' }))
  await markPaid(startedJobId, paidItemId)
  await addItem(startedJobId, ownerId,
    purchase({ materialName: 'Free offcuts', supplierName: 'Sydenhams', amount: '0' }))
  await addItem(startedJobId, ownerId, {
    memoryType: 'labour', labourPerson: 'Dave', labourTask: 'Framing', labourHours: '8',
    costAmount: '300', costCurrency: 'GBP', costQualifier: 'total',
  })
  await addItem(startedJobId, ownerId, {
    memoryType: 'budget_cost', summary: 'Digger hire', supplierName: 'Sydenhams',
    costAmount: '400', costCurrency: 'GBP', costQualifier: 'total',
  })
  const leftoverId = await addItem(startedJobId, ownerId, {
    memoryType: 'leftover_material', materialName: 'Spare OSB', quantity: '4', unit: 'sheets',
  })
  const returned = await app.inject({
    method: 'POST',
    url: `/api/jobs/${startedJobId}/memory-items/${leftoverId}/return`,
    headers: jsonHeaders(ownerId),
    payload: { quantity: '4', unit: 'sheets', supplierName: 'Sydenhams', refundAmount: '80', refundCurrency: 'GBP' },
  })
  expect(returned.statusCode, JSON.stringify(returned.json())).toBe(201)

  // Archived job and another user's job never enter the read model.
  await addItem(archivedJobId, ownerId,
    purchase({ materialName: 'Archived timber', supplierName: 'Sydenhams', amount: '1000' }))
  await addItem(otherUserJobId, otherOwnerId,
    purchase({ materialName: 'Other timber', supplierName: 'Sydenhams', amount: '7000' }))

  // Customer payments: 2500 owed on the started job, 1500 on the finished job,
  // nothing owed on the planning job, overpaid on the overpaid job.
  await prisma.jobPayment.createMany({
    data: [
      { jobId: startedJobId, amount: '1500', currency: 'GBP', paidAt: new Date('2026-07-10T11:00:00.000Z') },
      { jobId: planningJobId, amount: '1000', currency: 'GBP', paidAt: new Date('2026-07-11T11:00:00.000Z') },
      { jobId: finishedJobId, amount: '500', currency: 'GBP', paidAt: new Date('2026-07-12T11:00:00.000Z') },
      { jobId: overpaidJobId, amount: '900', currency: 'GBP', paidAt: new Date('2026-07-13T11:00:00.000Z') },
      { jobId: otherUserJobId, amount: '10', currency: 'GBP', paidAt: new Date('2026-07-14T11:00:00.000Z') },
    ],
  })
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

// ── Auth and privacy ──────────────────────────────────────────────────────────

describe('GET /api/book/money auth and owner scoping', () => {
  it('requires an authenticated user', async () => {
    const res = await app.inject({ method: 'GET', url: BOOK_MONEY_URL })
    expect(res.statusCode).toBe(401)
  })

  it('never includes another user\'s jobs, costs or payments', async () => {
    const body = await bookMoney(ownerId)
    const allJobIds = [
      ...(body.toPayOnAccounts?.supplierGroups ?? []).flatMap((g: { lines: Array<{ jobId: string }> }) => g.lines.map((l) => l.jobId)),
      ...(body.toPayOnAccounts?.missingPriceItems ?? []).map((i: { jobId: string }) => i.jobId),
      ...(body.owedToMe?.jobs ?? []).map((j: { jobId: string }) => j.jobId),
    ]
    expect(allJobIds).not.toContain(otherUserJobId)
    expect(allJobIds).not.toContain(archivedJobId)

    // The other builder sees only their own book.
    const otherBody = await bookMoney(otherOwnerId)
    expect(otherBody.toPayOnAccounts.totalAmount).toBe('7000')
    expect(otherBody.toPayOnAccounts.supplierGroups[0].lines.map((l: { jobId: string }) => l.jobId)).toEqual([otherUserJobId])
    expect(otherBody.owedToMe.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([otherUserJobId])
  })

  it('returns an empty read model for a user with no jobs', async () => {
    const lonely = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}lonely@test.local`, name: 'Lonely', role: 'PILOT' } })
    const body = await bookMoney(lonely.id)
    expect(body.toPayOnAccounts).toBeNull()
    expect(body.owedToMe).toBeNull()
    expect(body.bookHome.showMoneyRow).toBe(false)
    expect(body.bookHome.missingPriceCount).toBe(0)
  })
})

// ── To pay on accounts ────────────────────────────────────────────────────────

describe('To pay on accounts', () => {
  it('groups unpaid priced purchases by supplier across started, planning and finished jobs', async () => {
    const body = await bookMoney()
    const toPay = body.toPayOnAccounts

    // 500 Travis Perkins + 350 Sydenhams + 10 Sydenham's + 40 Supplier needed
    expect(toPay.totalAmount).toBe('900')
    expect(toPay.currency).toBe('GBP')
    expect(toPay.totalLabel).toBe('£900')
    expect(toPay.pricedCostCount).toBe(6)
    expect(toPay.namedSupplierCount).toBe(3)
    expect(toPay.unnamedSupplierGroupCount).toBe(1)

    // Named suppliers by total desc, Supplier needed last.
    expect(toPay.supplierGroups.map((g: { displayName: string }) => g.displayName))
      .toEqual(['Travis Perkins', 'Sydenhams', "Sydenham's", 'Supplier needed'])

    const sydenhams = groupNamed(body, 'Sydenhams')!
    expect(sydenhams.totalAmount).toBe('350')
    expect(sydenhams.purchaseCount).toBe(3)
    expect(sydenhams.distinctJobCount).toBe(2)
    expect(sydenhams.jobContextLabel).toBe('2 jobs')
    expect(sydenhams.kind).toBe('named_supplier')

    // Finished-job costs stay eligible, and a single-job group names the job.
    const travis = groupNamed(body, 'Travis Perkins')!
    expect(travis.lines[0].jobId).toBe(finishedJobId)
    expect(travis.lines[0].jobStatus).toBe('finished')
    expect(travis.lines[0].jobStatusLabel).toBe('Finished')
    expect(travis.jobContextLabel).toBe('Broadstone extension')
  })

  it('keeps similar supplier names as separate accounts', async () => {
    const body = await bookMoney()
    expect(groupNamed(body, 'Sydenhams')!.totalAmount).toBe('350')
    expect(groupNamed(body, "Sydenham's")!.totalAmount).toBe('10')
    const ids = body.toPayOnAccounts.supplierGroups.map((g: { groupId: string }) => g.groupId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns supplier lines oldest first with source navigation fields', async () => {
    const body = await bookMoney()
    const sydenhams = groupNamed(body, 'Sydenhams')!
    expect(sydenhams.lines.map((l: { amount: string }) => l.amount)).toEqual(['50', '100', '200'])

    const [oldest] = sydenhams.lines
    expect(oldest).toMatchObject({
      sourceMemoryItemId: sydenhamsSmallItemId,
      jobId: startedJobId,
      jobTitle: 'Mark fence',
      jobStatus: 'started',
      jobStatusLabel: 'In progress',
      itemLabel: 'Timber',
      quantityLabel: '10 sheets',
      amount: '50',
      currency: 'GBP',
      amountLabel: '£50',
      supplierName: 'Sydenhams',
    })
    expect(oldest.sourceDate).toMatch(/^2026-06-01/)
    expect(oldest.sourceDateLabel).toBe('1 Jun 2026')
  })

  it('includes an unsupplied priced cost in Supplier needed and in the total', async () => {
    const body = await bookMoney()
    const needed = groupNamed(body, 'Supplier needed')!
    expect(needed.kind).toBe('supplier_needed')
    expect(needed.supplierName).toBeNull()
    expect(needed.totalAmount).toBe('40')
    expect(needed.purchaseCount).toBe(1)
    expect(needed.lines[0].sourceMemoryItemId).toBe(noSupplierItemId)
    // Counted in the total and the priced-cost count, but not as a named account.
    expect(body.toPayOnAccounts.namedSupplierCount).toBe(3)
    expect(body.toPayOnAccounts.unnamedSupplierGroupCount).toBe(1)
  })

  it('excludes paid, £0, labour, generic budget cost, returned and archived rows', async () => {
    const body = await bookMoney()
    const labels = body.toPayOnAccounts.supplierGroups
      .flatMap((g: { lines: Array<{ itemLabel: string }> }) => g.lines.map((l) => l.itemLabel))
    expect(labels).toEqual(expect.arrayContaining(['Timber', 'Plasterboard', 'Insulation', 'Screws', 'Blocks', 'Sand']))
    expect(labels).not.toContain('Paid tiles')
    expect(labels).not.toContain('Free offcuts')
    expect(labels).not.toContain('Framing')
    expect(labels).not.toContain('Digger hire')
    expect(labels).not.toContain('Spare OSB')
    expect(labels).not.toContain('Archived timber')

    // Nothing excluded leaked into the missing-price block either.
    const missingLabels = body.toPayOnAccounts.missingPriceItems.map((i: { itemLabel: string }) => i.itemLabel)
    expect(missingLabels).not.toContain('Free offcuts')
    expect(missingLabels).not.toContain('Digger hire')
    expect(missingLabels).not.toContain('Framing')
  })
})

// ── Missing price ─────────────────────────────────────────────────────────────

describe('Missing price', () => {
  it('lists unpriced purchases outside every total, once each', async () => {
    const body = await bookMoney()
    const missing = body.toPayOnAccounts.missingPriceItems
    expect(missing.map((i: { itemLabel: string }) => i.itemLabel).sort()).toEqual(['Fixings', 'Membrane'])
    expect(body.bookHome.missingPriceCount).toBe(2)

    // Excluded from totals and counts — never represented as £0.
    expect(body.toPayOnAccounts.totalAmount).toBe('900')
    expect(body.toPayOnAccounts.pricedCostCount).toBe(6)
    expect(JSON.stringify(missing)).not.toContain('"amount"')

    const fixings = missing.find((i: { itemLabel: string }) => i.itemLabel === 'Fixings')
    expect(fixings).toMatchObject({
      sourceMemoryItemId: missingPriceItemId,
      jobId: startedJobId,
      jobTitle: 'Mark fence',
      jobStatus: 'started',
      supplierName: 'Jewson',
      reason: 'missing_price',
    })
    expect(fixings.reasonLabel).toContain('£900')
  })

  it('shows an item missing both price and supplier only under missing price', async () => {
    const body = await bookMoney()
    const needed = groupNamed(body, 'Supplier needed')!
    expect(needed.lines.map((l: { itemLabel: string }) => l.itemLabel)).not.toContain('Membrane')
    const membrane = body.toPayOnAccounts.missingPriceItems.find((i: { itemLabel: string }) => i.itemLabel === 'Membrane')
    expect(membrane.supplierName).toBeNull()
  })

  it('classifies untrusted and non-GBP prices as missing-price reasons', async () => {
    await rawItem(startedJobId, ownerId, {
      summary: 'Euro decking', materialName: 'Euro decking',
      costAmount: '90', costCurrency: 'EUR', costQualifier: 'total', totalCostAmount: '90',
      supplierName: 'Continental Timber', unresolvedFlags: [],
    })
    await rawItem(startedJobId, ownerId, {
      summary: 'About half a load of sand', materialName: 'Sand (about half a load)',
      costAmount: '60', costCurrency: 'GBP', costQualifier: 'total', totalCostAmount: '60',
      supplierName: 'Sydenhams', unresolvedFlags: ['cost_uncertain'],
    })

    const body = await bookMoney()
    const byLabel = new Map(body.toPayOnAccounts.missingPriceItems.map((i: { itemLabel: string }) => [i.itemLabel, i]))
    expect((byLabel.get('Euro decking') as { reason: string }).reason).toBe('unsupported_currency')
    expect((byLabel.get('Sand (about half a load)') as { reason: string }).reason).toBe('untrusted_price')
    // Neither entered a supplier total.
    expect(body.toPayOnAccounts.totalAmount).toBe('900')
    expect(groupNamed(body, 'Sydenhams')!.totalAmount).toBe('350')
  })

  it('reports a missing-price-only book without a £0 supplier total', async () => {
    await cleanupJobsOf([ownerId, otherOwnerId])
    const jobId = await job(ownerId, 'Just started', 'STARTED')
    await addItem(jobId, ownerId, purchase({ materialName: 'Fixings', supplierName: 'Jewson', amount: null }))

    const body = await bookMoney()
    expect(body.toPayOnAccounts.totalAmount).toBeNull()
    expect(body.toPayOnAccounts.currency).toBeNull()
    expect(body.toPayOnAccounts.totalLabel).toBeNull()
    expect(body.toPayOnAccounts.supplierGroups).toEqual([])
    expect(body.toPayOnAccounts.summaryLabel).toBe('1 cost needs a price')
    expect(body.owedToMe).toBeNull()
    expect(body.bookHome).toMatchObject({
      showMoneyRow: true,
      toPayOnAccountsAmount: null,
      owedToMeAmount: null,
      missingPriceCount: 1,
      missingPriceLabel: '1 cost needs a price',
    })
  })
})

// ── Owed to me ────────────────────────────────────────────────────────────────

describe('Owed to me', () => {
  it('uses trusted customer total minus customer payments, positive only', async () => {
    const body = await bookMoney()
    const owed = body.owedToMe

    expect(owed.totalAmount).toBe('4000')
    expect(owed.jobCount).toBe(2)
    // Owed desc.
    expect(owed.jobs.map((j: { jobId: string }) => j.jobId)).toEqual([startedJobId, finishedJobId])
    expect(owed.jobs[0]).toMatchObject({
      jobTitle: 'Mark fence',
      jobStatus: 'started',
      jobStatusLabel: 'In progress',
      roughLocationOrLabel: 'Wimborne',
      owedAmount: '2500',
      owedLabel: '£2500 owed',
      customerTotalAmount: '4000',
      moneyInAmount: '1500',
      moneyInLabel: '£1500 received',
      contextLabel: null,
    })
    // A finished job stays visible while money is still owed.
    expect(owed.jobs[1]).toMatchObject({ jobId: finishedJobId, owedAmount: '1500', contextLabel: 'finished job' })
  })

  it('excludes zero-owed, overpaid and missing-total jobs', async () => {
    const body = await bookMoney()
    const ids = body.owedToMe.jobs.map((j: { jobId: string }) => j.jobId)
    expect(ids).not.toContain(planningJobId) // paid in full
    expect(ids).not.toContain(overpaidJobId) // overpaid, never negative
    expect(body.owedToMe.jobs.every((j: { owedAmount: string }) => parseFloat(j.owedAmount) > 0)).toBe(true)
    expect(ids).toHaveLength(2)
  })

  it('omits the section entirely when nothing is owed', async () => {
    await prisma.jobPayment.deleteMany({ where: { jobId: { in: [startedJobId, finishedJobId] } } })
    await prisma.job.updateMany({
      where: { id: { in: [startedJobId, finishedJobId] } },
      data: { customerTotalAmount: null, customerTotalCurrency: null },
    })
    const body = await bookMoney()
    expect(body.owedToMe).toBeNull()
    expect(body.bookHome.owedToMeAmount).toBeNull()
    expect(body.bookHome.owedToMeLabel).toBeNull()
  })
})

// ── Book Home summary ─────────────────────────────────────────────────────────

describe('Book Home summary', () => {
  it('is derived from exactly the same facts as the overview', async () => {
    const body = await bookMoney()
    expect(body.bookHome).toMatchObject({
      showMoneyRow: true,
      toPayOnAccountsAmount: body.toPayOnAccounts.totalAmount,
      toPayOnAccountsCurrency: 'GBP',
      toPayOnAccountsLabel: '£900 to pay on accounts',
      owedToMeAmount: body.owedToMe.totalAmount,
      owedToMeCurrency: 'GBP',
      owedToMeLabel: '£4000 owed to me',
      missingPriceCount: body.toPayOnAccounts.missingPriceItems.length,
      missingPriceLabel: '2 costs need a price',
    })
  })

  it('hides the Money row when there is nothing to show', async () => {
    await cleanupJobsOf([ownerId, otherOwnerId])
    await job(ownerId, 'Quiet job', 'STARTED')
    const body = await bookMoney()
    expect(body).toMatchObject({ toPayOnAccounts: null, owedToMe: null })
    expect(body.bookHome.showMoneyRow).toBe(false)
    expect(body.bookHome.toPayOnAccountsLabel).toBeNull()
    expect(body.bookHome.owedToMeLabel).toBeNull()
  })

  it('shows one direction only when that is all there is', async () => {
    await prisma.jobPayment.deleteMany({ where: { jobId: { in: [startedJobId, finishedJobId] } } })
    await prisma.job.updateMany({
      where: { ownerUserId: ownerId },
      data: { customerTotalAmount: null, customerTotalCurrency: null },
    })
    const body = await bookMoney()
    expect(body.owedToMe).toBeNull()
    expect(body.toPayOnAccounts.totalAmount).toBe('900')
    expect(body.bookHome.showMoneyRow).toBe(true)
    expect(body.bookHome.owedToMeAmount).toBeNull()
  })
})

// ── Source corrections move the read model ────────────────────────────────────

describe('Source changes are reflected without duplicate records', () => {
  it('drops a cost marked paid at the source and restores it when paid is undone', async () => {
    const before = await bookMoney()
    expect(groupNamed(before, 'Sydenhams')!.totalAmount).toBe('350')

    const money = await markPaid(startedJobId, sydenhamsSmallItemId)
    const paidEventId = money.rows.find((r: { sourceMemoryItemId: string }) => r.sourceMemoryItemId === sydenhamsSmallItemId).id

    const afterPaid = await bookMoney()
    expect(groupNamed(afterPaid, 'Sydenhams')!.totalAmount).toBe('300')
    expect(groupNamed(afterPaid, 'Sydenhams')!.purchaseCount).toBe(2)
    expect(afterPaid.toPayOnAccounts.totalAmount).toBe('850')
    expect(afterPaid.bookHome.toPayOnAccountsAmount).toBe('850')

    const undo = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${startedJobId}/money/events/${paidEventId}`,
      headers: authHeaders(ownerId),
    })
    expect(undo.statusCode).toBe(204)

    const afterUndo = await bookMoney()
    expect(groupNamed(afterUndo, 'Sydenhams')!.totalAmount).toBe('350')
    expect(afterUndo.toPayOnAccounts.totalAmount).toBe('900')
  })

  it('moves a cost between groups when the supplier is corrected at the source', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${startedJobId}/memory-items/${noSupplierItemId}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', supplierName: 'Travis Perkins' },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)

    const body = await bookMoney()
    expect(groupNamed(body, 'Supplier needed')).toBeUndefined()
    expect(groupNamed(body, 'Travis Perkins')!.totalAmount).toBe('540')
    expect(body.toPayOnAccounts.unnamedSupplierGroupCount).toBe(0)
    // Same money, only regrouped.
    expect(body.toPayOnAccounts.totalAmount).toBe('900')
    expect(body.toPayOnAccounts.pricedCostCount).toBe(6)
  })

  it('moves a missing-price cost into its supplier group when a price is added', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${startedJobId}/memory-items/${missingPriceItemId}`,
      headers: jsonHeaders(ownerId),
      // The stated total is sent explicitly: unlike direct-add, the material
      // patch path does not derive a total from costQualifier 'total'.
      payload: { memoryType: 'ordered_material', costAmount: '25', costCurrency: 'GBP', costQualifier: 'total', totalCostAmount: '25' },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)

    const body = await bookMoney()
    expect(body.toPayOnAccounts.missingPriceItems.map((i: { itemLabel: string }) => i.itemLabel)).toEqual(['Membrane'])
    expect(groupNamed(body, 'Jewson')!.totalAmount).toBe('25')
    expect(body.toPayOnAccounts.totalAmount).toBe('925')
    expect(body.bookHome.missingPriceCount).toBe(1)
    expect(body.bookHome.missingPriceLabel).toBe('1 cost needs a price')
  })

  it('drops a cost removed at the source', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${startedJobId}/memory-items/${sydenhamsSmallItemId}`,
      headers: authHeaders(ownerId),
    })
    expect(res.statusCode).toBe(204)
    const body = await bookMoney()
    expect(groupNamed(body, 'Sydenhams')!.totalAmount).toBe('300')
    expect(body.toPayOnAccounts.totalAmount).toBe('850')
  })

  it('reflects a customer payment recorded at the source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${startedJobId}/payments`,
      headers: jsonHeaders(ownerId),
      payload: { amount: '1000', paidAt: '2026-07-20' },
    })
    expect([200, 201]).toContain(res.statusCode)
    const body = await bookMoney()
    const startedRow = body.owedToMe.jobs.find((j: { jobId: string }) => j.jobId === startedJobId)
    expect(startedRow.owedAmount).toBe('1500')
    expect(startedRow.moneyInAmount).toBe('2500')
    expect(body.owedToMe.totalAmount).toBe('3000')
  })

  it('writes nothing when the cross-job Money page is opened', async () => {
    const counts = async () => ({
      memoryItems: await prisma.memoryItem.count(),
      moneyEvents: await prisma.jobMoneyEvent.count(),
      payments: await prisma.jobPayment.count(),
      decisions: await prisma.reviewDecision.count(),
      queueItems: await prisma.queueItem.count(),
      jobs: await prisma.job.count(),
    })
    const before = await counts()
    await bookMoney()
    await bookMoney()
    expect(await counts()).toEqual(before)
  })
})
