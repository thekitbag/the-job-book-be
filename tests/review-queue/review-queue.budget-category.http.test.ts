// Review queue budget-category behaviour: suggestion rules on GET
// (material-name match, summary token match, ambiguity) and category
// selection/validation on decisions.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, JOB_ID, ITEM_ID, CAT_TIMBER, CAT_FIXINGS,
  resetReviewQueueMocks, makeFact, makeQueueItem, makeMemoryItem,
  makeBudgetCategory, makeOrderedFact, makeOrderedQueueItem,
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

function orderedProposed(body: any) {
  return body.sections.find((s: any) => s.key === 'ordered_materials').items[0].proposedMemory
}

async function getQueue({ facts, queueItems, categories }: any) {
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue(facts)
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce(queueItems)
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue(categories)
  return app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
}

describe('GET review-queue — budget category suggestions', () => {
  it('returns active budgetCategories', async () => {
    const res = await getQueue({ facts: [], queueItems: [], categories: [makeBudgetCategory()] })
    const body = res.json()
    expect(body.budgetCategories).toHaveLength(1)
    expect(body.budgetCategories[0]).toMatchObject({ id: CAT_TIMBER, name: 'timber' })
  })

  it('suggests on exact material-name match', async () => {
    const res = await getQueue({ facts: [makeOrderedFact()], queueItems: [makeOrderedQueueItem()], categories: [makeBudgetCategory()] })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategoryId).toBe(CAT_TIMBER)
    expect(pm.budgetCategorySuggestion).toMatchObject({ budgetCategoryId: CAT_TIMBER, categoryName: 'timber', reason: 'material_name_match' })
  })

  it('suggests on exact summary token match when material name does not match', async () => {
    const fact = makeOrderedFact({ materialName: 'softwood', summary: 'Ordered a load of timber for the frame' })
    const qi = makeOrderedQueueItem({ proposedMemory: { memoryType: 'ordered_material', summary: 'Ordered a load of timber for the frame', materialName: 'softwood', quantity: '1', unit: 'load', supplierName: null, deliveryTiming: null, locationOrUse: null } })
    const res = await getQueue({ facts: [fact], queueItems: [qi], categories: [makeBudgetCategory()] })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategorySuggestion).toMatchObject({ reason: 'summary_match', budgetCategoryId: CAT_TIMBER })
  })

  it('does not match a category name embedded inside another word', async () => {
    const qi = makeOrderedQueueItem({ proposedMemory: { memoryType: 'ordered_material', summary: 'Ordered timberland boots', materialName: 'boots', quantity: '1', unit: 'pair', supplierName: null, deliveryTiming: null, locationOrUse: null } })
    const res = await getQueue({ facts: [makeOrderedFact()], queueItems: [qi], categories: [makeBudgetCategory()] })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategoryId).toBeNull()
    expect(pm.budgetCategorySuggestion).toBeNull()
  })

  it('returns no suggestion when two categories match by summary', async () => {
    const qi = makeOrderedQueueItem({ proposedMemory: { memoryType: 'ordered_material', summary: 'Ordered timber and fixings', materialName: 'mixed', quantity: '1', unit: 'load', supplierName: null, deliveryTiming: null, locationOrUse: null } })
    const cats = [makeBudgetCategory(), makeBudgetCategory({ id: CAT_FIXINGS, name: 'fixings' })]
    const res = await getQueue({ facts: [makeOrderedFact()], queueItems: [qi], categories: cats })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategoryId).toBeNull()
    expect(pm.budgetCategorySuggestion).toBeNull()
  })

  it('prefers a material-name match even when others match by summary', async () => {
    const qi = makeOrderedQueueItem({ proposedMemory: { memoryType: 'ordered_material', summary: 'Ordered timber and fixings', materialName: 'fixings', quantity: '1', unit: 'box', supplierName: null, deliveryTiming: null, locationOrUse: null } })
    const cats = [makeBudgetCategory(), makeBudgetCategory({ id: CAT_FIXINGS, name: 'fixings' })]
    const res = await getQueue({ facts: [makeOrderedFact()], queueItems: [qi], categories: cats })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategorySuggestion).toMatchObject({ budgetCategoryId: CAT_FIXINGS, reason: 'material_name_match' })
  })

  it('returns no suggestion when there are no categories', async () => {
    const res = await getQueue({ facts: [makeOrderedFact()], queueItems: [makeOrderedQueueItem()], categories: [] })
    const pm = orderedProposed(res.json())
    expect(pm.budgetCategoryId).toBeNull()
    expect(pm.budgetCategorySuggestion).toBeNull()
  })

  it('does not suggest for non-ordered draft items', async () => {
    // default makeFact/makeQueueItem are used_material; even a name-matching category must not suggest
    const cats = [makeBudgetCategory({ name: 'OSB' })]
    const res = await getQueue({ facts: [makeFact()], queueItems: [makeQueueItem()], categories: cats })
    const body = res.json()
    const pm = body.sections.find((s: any) => s.key === 'used_materials').items[0].proposedMemory
    expect(pm.budgetCategoryId).toBeNull()
    expect(pm.budgetCategorySuggestion).toBeNull()
  })

  it('alreadyRemembered items include budgetCategoryId', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([makeMemoryItem({ budgetCategoryId: CAT_TIMBER })])
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${JOB_ID}/review-queue`, headers: { 'x-pilot-user-id': USER_ID } })
    expect(res.json().alreadyRemembered[0].budgetCategoryId).toBe(CAT_TIMBER)
  })
})

describe('POST review-queue-decisions — budget category selection', () => {
  const post = (payload: any) =>
    app.inject({ method: 'POST', url: `/api/jobs/${JOB_ID}/review-queue-decisions`, headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID }, payload })

  it('confirm persists the selected category onto the memory item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory())
    const res = await post({ queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: CAT_TIMBER })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ budgetCategoryId: CAT_TIMBER }) }))
  })

  it('confirm with budgetCategoryId:null remembers uncategorised', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    const res = await post({ queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: null })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ budgetCategoryId: null }) }))
  })

  it('correct persists category from corrected.budgetCategoryId', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory())
    const res = await post({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'ordered_material', summary: 'Ordered 2 loads of timber', budgetCategoryId: CAT_TIMBER } })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ budgetCategoryId: CAT_TIMBER }) }))
  })

  it('rejects a category on a non-ordered corrected memory type with 400', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory())
    const res = await post({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'used_material', summary: 'Used the timber', budgetCategoryId: CAT_TIMBER } })
    expect(res.statusCode).toBe(400)
    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
  })

  it('rejects top-level and corrected category that disagree with 400', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory())
    const res = await post({ queueItemId: ITEM_ID, action: 'correct', budgetCategoryId: CAT_TIMBER, corrected: { memoryType: 'ordered_material', summary: 'x', budgetCategoryId: CAT_FIXINGS } })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a category from another job with 404', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
    const res = await post({ queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: 'other-job-cat' })
    expect(res.statusCode).toBe(404)
  })

  it('rejects an archived category with 400', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeOrderedQueueItem())
    vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(makeBudgetCategory({ isArchived: true }))
    const res = await post({ queueItemId: ITEM_ID, action: 'confirm', budgetCategoryId: CAT_TIMBER })
    expect(res.statusCode).toBe(400)
  })
})
