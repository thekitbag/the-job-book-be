// Review queue labour behaviour: labour section grouping, labour category
// suggestion, labour field persistence on confirm/correct, and labour fields
// on alreadyRemembered.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, JOB_ID, FACT_ID, ITEM_ID, CAT_LABOUR,
  resetReviewQueueMocks, makeFact, makeMemoryItem, makeBudgetCategory, makeLabourQueueItem,
} from '../helpers/review-queue-test-builders.js'

vi.mock('../../src/db/client.js', async () => {
  const { createReviewQueuePrismaMock } = await import('../helpers/review-queue-test-builders.js')
  return { prisma: createReviewQueuePrismaMock() }
})

let app: FastifyInstance
let prisma: Awaited<ReturnType<typeof resetReviewQueueMocks>>

beforeAll(async () => {
  app = buildTestApp()
  await app.ready()
})

afterAll(() => app.close())

beforeEach(async () => {
  vi.clearAllMocks()
  prisma = await resetReviewQueueMocks()
})

describe('review-queue — labour', () => {
  it('groups labour facts under a labour section', async () => {
    const fact = makeFact({ id: FACT_ID, factType: 'LABOUR', materialName: null, summary: 'Spent 6 hours fitting cladding', labourHours: '6', labourTask: 'fitting cladding' })
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([fact])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeLabourQueueItem({ proposedMemory: { memoryType: 'labour', summary: 'Spent 6 hours fitting cladding', materialName: null, quantity: null, unit: null, supplierName: null, deliveryTiming: null, locationOrUse: null, costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null, labourHours: '6', labourPerson: null, labourTask: 'fitting cladding' } })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const body = res.json()
    const labourSection = body.sections.find((s: any) => s.key === 'labour')
    expect(labourSection.items).toHaveLength(1)
    const pm = labourSection.items[0].proposedMemory
    expect(pm.labourHours).toBe('6')
    expect(pm.labourTask).toBe('fitting cladding')
  })

  it('suggests an active category named "labour" for labour facts', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact({ factType: 'LABOUR' })])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeLabourQueueItem()])
    vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([makeBudgetCategory({ id: CAT_LABOUR, name: 'labour' })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const pm = res.json().sections.find((s: any) => s.key === 'labour').items[0].proposedMemory
    expect(pm.budgetCategoryId).toBe(CAT_LABOUR)
    expect(pm.budgetCategorySuggestion).toMatchObject({ budgetCategoryId: CAT_LABOUR, reason: 'material_name_match' })
  })

  it('confirm persists labour fields and category into the memory item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory({ id: CAT_LABOUR, name: 'labour' }))
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: { queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: CAT_LABOUR } })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      memoryType: 'LABOUR', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics', totalCostAmount: '280', budgetCategoryId: CAT_LABOUR,
    }) }))
  })

  it('correct derives a safe per_hour total for labour', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: {
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'labour', summary: 'Tom did 10 hours on electrics at £35/hr', labourHours: '10', labourPerson: 'Tom', labourTask: 'electrics', costAmount: '35', costCurrency: 'GBP', costQualifier: 'per_hour' },
    } })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ labourHours: '10', totalCostAmount: '350' }) }))
  })

  it('allows a category on labour via confirm', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory({ id: CAT_LABOUR, name: 'labour' }))
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: { queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: CAT_LABOUR } })
    expect(res.statusCode).toBe(200)
  })

  it('alreadyRemembered exposes labour fields', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([makeMemoryItem({ memoryType: 'LABOUR', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics' })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const ar = res.json().alreadyRemembered[0]
    expect(ar.labourHours).toBe('8')
    expect(ar.labourPerson).toBe('Tom')
    expect(ar.labourTask).toBe('electrics')
  })
})
