// Real-DB contract tests for the category-aware Budget payment state. These
// deliberately exercise the public HTTP workflow so paid state cannot drift
// from either committed Budget cost or the Money read model.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'budget-payment-state-'
let app: FastifyInstance
let ownerId: string
let jobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((user) => user.id)
  if (!userIds.length) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((job) => job.id)
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

beforeAll(async () => {
  app = buildApp({ storage: new FakeAudioStorage(), transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Owner', role: 'PILOT' } })).id
})
afterAll(async () => { await cleanup(); await app.close() })
beforeEach(async () => { jobId = (await prisma.job.create({ data: { ownerUserId: ownerId, title: 'Payment-state job', jobType: 'garden_room' } })).id })

const headers = () => ({ 'x-pilot-user-id': ownerId, 'content-type': 'application/json' })
const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-pilot-user-id': ownerId } })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: headers(), payload })
const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: headers(), payload })
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { 'x-pilot-user-id': ownerId } })
const memoryUrl = () => `/api/jobs/${jobId}/memory-items`
const budgetUrl = () => `/api/jobs/${jobId}/budget-summary`
const moneyUrl = () => `/api/jobs/${jobId}/money`

async function category(name: string) {
  return prisma.jobBudgetCategory.create({ data: { jobId, name, sortOrder: 0 } })
}
async function material(categoryId: string, amount: string | null, markPaid = false) {
  const body: Record<string, unknown> = { memoryType: 'ordered_material', summary: `Material ${amount ?? 'unknown'}`, materialName: 'OSB', budgetCategoryId: categoryId, markPaid }
  if (amount !== null) Object.assign(body, { costAmount: amount, costCurrency: 'GBP', costQualifier: 'total' })
  const response = await post(memoryUrl(), body)
  expect(response.statusCode).toBe(201)
  return response.json()
}

describe('category payment state', () => {
  it('reports paid, not paid, mixed and no-eligible states without changing committed Budget arithmetic', async () => {
    const allPaid = await category('All paid')
    const allUnpaid = await category('All unpaid')
    const mixed = await category('Mixed')
    const attention = await category('Needs price')
    const zero = await category('Zero cost')
    await material(allPaid.id, '100', true)
    await material(allUnpaid.id, '80')
    await material(mixed.id, '20', true)
    await material(mixed.id, '30')
    await material(attention.id, '40', true)
    await material(attention.id, null)
    // A conflicting stated total is deliberately untrusted: it stays out of
    // Budget/payment arithmetic but prevents an all-clear paid badge.
    const conflicting = await post(memoryUrl(), {
      memoryType: 'ordered_material', summary: 'Conflicting OSB cost', materialName: 'OSB', budgetCategoryId: attention.id,
      quantity: '2', unit: 'sheets', costAmount: '10', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '25',
    })
    expect(conflicting.statusCode).toBe(201)
    await material(zero.id, '0')

    const summary = (await get(budgetUrl())).json()
    const byName = new Map(summary.categories.map((entry: any) => [entry.category.name, entry]))
    expect(byName.get('All paid')).toMatchObject({ knownSpendAmount: '100', paymentState: 'paid', paidAmount: '100', notPaidAmount: null, paymentStateReason: 'eligible_items' })
    expect(byName.get('All unpaid')).toMatchObject({ knownSpendAmount: '80', paymentState: 'not_paid', paidAmount: null, notPaidAmount: '80', paymentStateReason: 'eligible_items' })
    expect(byName.get('Mixed')).toMatchObject({ knownSpendAmount: '50', paymentState: 'some_paid', paidAmount: '20', notPaidAmount: '30', paymentStateReason: 'eligible_items' })
    expect(byName.get('Needs price')).toMatchObject({ knownSpendAmount: '40', paymentState: 'paid', paidAmount: '40', paymentStateReason: 'missing_price_present' })
    expect(byName.get('Zero cost')).toMatchObject({ knownSpendAmount: null, paymentState: null, paidAmount: null, notPaidAmount: null, paymentStateReason: 'no_eligible_items' })
    expect(byName.get('Mixed').rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ eligibleForPaymentState: true, paymentState: 'paid', paidMoneyEventId: expect.any(String), paidAt: expect.any(String) }),
      expect.objectContaining({ eligibleForPaymentState: true, paymentState: 'not_paid', paidMoneyEventId: null, paidAt: null }),
    ]))
    expect(summary.totals.knownSpendAmount).toBe('270')
  })

  it('marks a material paid and undoes it without changing its Budget row or totals', async () => {
    const cat = await category('Structure')
    const source = await material(cat.id, '125')
    const before = (await get(budgetUrl())).json()
    const beforeCategory = before.categories.find((entry: any) => entry.category.id === cat.id)
    const paid = await post(`/api/jobs/${jobId}/money/out`, { sourceMemoryItemId: source.id })
    expect(paid.statusCode).toBe(200)
    const afterPaid = (await get(budgetUrl())).json()
    const paidCategory = afterPaid.categories.find((entry: any) => entry.category.id === cat.id)
    expect(afterPaid.totals).toEqual(before.totals)
    expect(paidCategory.knownSpendAmount).toBe(beforeCategory.knownSpendAmount)
    expect(paidCategory.rows[0]).toMatchObject({ memoryItemId: source.id, paymentState: 'paid', paidMoneyEventId: expect.any(String) })
    const money = (await get(moneyUrl())).json()
    const event = money.rows.find((row: any) => row.sourceMemoryItemId === source.id)
    expect(event).toMatchObject({ kind: 'cost_paid', amount: '125', sourceBudgetCategoryId: cat.id, sourceBudgetCategoryName: 'Structure' })
    expect((await del(`/api/jobs/${jobId}/money/events/${event.id}`)).statusCode).toBe(204)
    const afterUndo = (await get(budgetUrl())).json()
    const undoneCategory = afterUndo.categories.find((entry: any) => entry.category.id === cat.id)
    expect(afterUndo.totals).toEqual(before.totals)
    expect(undoneCategory.knownSpendAmount).toBe(beforeCategory.knownSpendAmount)
    expect(undoneCategory.rows[0]).toMatchObject({ memoryItemId: source.id, paymentState: 'not_paid', paidMoneyEventId: null, paidAt: null })
  })

  it('uses the source item’s current category for Money and rejects invalid material markPaid atomically', async () => {
    const first = await category('First category')
    const second = await category('Second category')
    const source = await material(first.id, '70', true)
    let money = (await get(moneyUrl())).json()
    expect(money.rows.find((row: any) => row.sourceMemoryItemId === source.id)).toMatchObject({ sourceBudgetCategoryId: first.id, sourceBudgetCategoryName: 'First category' })
    expect((await patch(`${memoryUrl()}/${source.id}`, { budgetCategoryId: second.id })).statusCode).toBe(200)
    money = (await get(moneyUrl())).json()
    expect(money.rows.find((row: any) => row.sourceMemoryItemId === source.id)).toMatchObject({ sourceBudgetCategoryId: second.id, sourceBudgetCategoryName: 'Second category' })
    expect((await patch(`${memoryUrl()}/${source.id}`, { budgetCategoryId: null })).statusCode).toBe(200)
    money = (await get(moneyUrl())).json()
    expect(money.rows.find((row: any) => row.sourceMemoryItemId === source.id)).toMatchObject({ sourceBudgetCategoryId: null, sourceBudgetCategoryName: null })

    const invalidBodies = [
      { memoryType: 'ordered_material', summary: 'Unpriced timber', materialName: 'Timber', budgetCategoryId: first.id, markPaid: true },
      { memoryType: 'ordered_material', summary: 'Free timber', materialName: 'Free timber', budgetCategoryId: first.id, costAmount: '0', costCurrency: 'GBP', costQualifier: 'total', markPaid: true },
      {
        memoryType: 'ordered_material', summary: 'Conflicting timber', materialName: 'Conflicting timber', budgetCategoryId: first.id,
        quantity: '2', unit: 'sheets', costAmount: '10', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '25', markPaid: true,
      },
    ]
    for (const body of invalidBodies) {
      const invalid = await post(memoryUrl(), body)
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json().code).toBe('INVALID_FIELD')
    }
    const moneyAfterInvalid = (await get(moneyUrl())).json()
    expect(moneyAfterInvalid.rows).toHaveLength(1)
    expect(await prisma.memoryItem.count({ where: { jobId } })).toBe(1)
  })
})
