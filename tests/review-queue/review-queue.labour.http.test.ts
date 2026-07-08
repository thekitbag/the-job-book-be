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

describe('review-queue — labour happenedAt (Labour Tracking V2)', () => {
  const HAPPENED = new Date('2026-06-09T11:00:00.000Z')

  it('exposes happenedAt on a labour proposedMemory', async () => {
    const fact = makeFact({ factType: 'LABOUR', materialName: null, summary: 'Mike worked 4 hours', labourHours: '4', labourPerson: 'Mike', labourTask: null, happenedAt: HAPPENED })
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([fact])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const pm = res.json().sections.find((s: any) => s.key === 'labour').items[0].proposedMemory
    expect(pm.happenedAt).toBe('2026-06-09T11:00:00.000Z')
    expect(pm.labourHours).toBe('4')
    expect(pm.labourPerson).toBe('Mike')
  })

  it('returns one queue item per labour fact from the same note ("Mike 4 hours, Kurt 6")', async () => {
    const mike = makeFact({ id: FACT_ID, factType: 'LABOUR', materialName: null, summary: 'Mike worked 4 hours', labourHours: '4', labourPerson: 'Mike', happenedAt: HAPPENED })
    const kurt = makeFact({ id: 'queue-fact-kurt', factType: 'LABOUR', materialName: null, summary: 'Kurt worked 6 hours', labourHours: '6', labourPerson: 'Kurt', happenedAt: HAPPENED })
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([mike, kurt])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    const items = res.json().sections.find((s: any) => s.key === 'labour').items
    expect(items).toHaveLength(2)
    expect(items.map((i: any) => i.proposedMemory.labourPerson).sort()).toEqual(['Kurt', 'Mike'])
  })

  it('confirm persists the proposed happenedAt on the memory item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: { queueItemId: ITEM_ID, action: 'confirm' } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked(prisma.memoryItem.create as any).mock.calls[0][0].data
    expect(data.happenedAt?.toISOString()).toBe('2026-06-09T11:00:00.000Z')
    expect(data.labourHours).toBe('8')
    expect(data.labourPerson).toBe('Tom')
    expect(data.labourTask).toBe('electrics')
  })

  it('correct can edit day, person, hours, and task together', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: {
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'labour', summary: 'Kurt did 6 hours on the roof', happenedAt: '2026-06-08T11:00:00.000Z', labourHours: '6', labourPerson: 'Kurt', labourTask: 'roof' },
    } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked(prisma.memoryItem.create as any).mock.calls[0][0].data
    expect(data.happenedAt?.toISOString()).toBe('2026-06-08T11:00:00.000Z')
    expect(data.labourHours).toBe('6')
    expect(data.labourPerson).toBe('Kurt')
    expect(data.labourTask).toBe('roof')
  })

  it('correct with happenedAt omitted preserves the proposed effective day', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: {
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'labour', summary: 'Tom did 8 hours on electrics', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics' },
    } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked(prisma.memoryItem.create as any).mock.calls[0][0].data
    expect(data.happenedAt?.toISOString()).toBe('2026-06-09T11:00:00.000Z')
  })

  it('correct with happenedAt null clears the effective day', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: {
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'labour', summary: 'Tom did 8 hours', happenedAt: null, labourHours: '8', labourPerson: 'Tom' },
    } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked(prisma.memoryItem.create as any).mock.calls[0][0].data
    expect(data.happenedAt).toBeNull()
  })

  it('rejects an invalid corrected.happenedAt with 400', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeLabourQueueItem())
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: {
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'labour', summary: 'Tom did 8 hours', happenedAt: 'not-a-date' },
    } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('INVALID_FIELD')
    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
  })

  it('confirming two labour queue items creates two memory items', async () => {
    const itemA = makeLabourQueueItem()
    const itemB = makeLabourQueueItem({ id: 'queue-item-2', summary: 'Kurt worked 6 hours', proposedMemory: { ...(makeLabourQueueItem() as any).proposedMemory, summary: 'Kurt worked 6 hours', labourPerson: 'Kurt', labourHours: '6' }, sourceCandidateFactIds: ['queue-fact-kurt'] })
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValueOnce(itemA).mockResolvedValueOnce(itemB)
    const post = (queueItemId: string) => app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload: { queueItemId, action: 'confirm' } })
    expect((await post(ITEM_ID)).statusCode).toBe(200)
    expect((await post('queue-item-2')).statusCode).toBe(200)
    const created = vi.mocked(prisma.memoryItem.create as any).mock.calls.map((c: any) => c[0].data)
    expect(created).toHaveLength(2)
    expect(created.map((d: any) => d.labourPerson)).toEqual(['Tom', 'Kurt'])
  })

  it('alreadyRemembered exposes happenedAt', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([makeMemoryItem({ memoryType: 'LABOUR', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics', happenedAt: HAPPENED })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    expect(res.json().alreadyRemembered[0].happenedAt).toBe('2026-06-09T11:00:00.000Z')
  })
})
