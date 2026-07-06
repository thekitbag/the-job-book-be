// POST /api/jobs/:jobId/review-queue-decisions — cost handling:
// cost field validation, uncertaintyResolution → unresolvedFlags persistence,
// and auto-total derivation from unit cost into trusted memory.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, JOB_ID, ITEM_ID,
  resetReviewQueueMocks, makeQueueItem,
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

function postDecision(payload: object) {
  return app.inject({
    method: 'POST',
    url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
    headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
    payload,
  })
}

describe('POST /api/jobs/:jobId/review-queue-decisions — cost field validation', () => {
  it('returns 400 INVALID_FIELD when corrected.costAmount is not a decimal string', async () => {
    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Some order', costAmount: 'abc' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.totalCostAmount is not a decimal string', async () => {
    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Some order', totalCostAmount: '£40' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.costQualifier is not a valid qualifier', async () => {
    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Some order', costQualifier: 'weekly' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('confirm: persists cost fields from proposedMemory to memory item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({
        sectionKey: 'ordered_materials',
        proposedMemory: {
          memoryType: 'ordered_material',
          summary: 'Ordered 8 bags of hardcore from Jewson at £5 each',
          materialName: 'hardcore',
          quantity: '8',
          unit: 'bags',
          supplierName: 'Jewson',
          deliveryTiming: null,
          locationOrUse: null,
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        },
      }),
    )

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        }),
      }),
    )
  })

  it('correct: persists cost fields from corrected body to memory item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: {
        memoryType: 'ordered_material',
        summary: 'Ordered 8 bags of hardcore at £5 each',
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '40',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each',
          totalCostAmount: '40',
        }),
      }),
    )
  })

  it('returns 400 INVALID_FIELD when uncertaintyResolution is not a valid value', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm', uncertaintyResolution: 'maybe' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })
})

describe('POST /api/jobs/:jobId/review-queue-decisions — uncertaintyResolution', () => {
  it('confirm omitting uncertaintyResolution stores unresolvedFlags: []', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ uncertaintyFlags: ['material_uncertain'] }),
    )

    await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: [] }) }),
    )
  })

  it('confirm with uncertaintyResolution:resolved stores unresolvedFlags: []', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ uncertaintyFlags: ['material_uncertain'] }),
    )

    await postDecision({ queueItemId: ITEM_ID, action: 'confirm', uncertaintyResolution: 'resolved' })

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: [] }) }),
    )
  })

  it('confirm with uncertaintyResolution:still_unsure copies flags from queue item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ uncertaintyFlags: ['material_uncertain', 'approximate_quantity'] }),
    )

    await postDecision({ queueItemId: ITEM_ID, action: 'confirm', uncertaintyResolution: 'still_unsure' })

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unresolvedFlags: ['material_uncertain', 'approximate_quantity'] }),
      }),
    )
  })

  it('correct omitting uncertaintyResolution stores unresolvedFlags: []', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ uncertaintyFlags: ['conflicting_quantity'] }),
    )

    await postDecision({
      queueItemId: ITEM_ID, action: 'correct',
      corrected: { memoryType: 'used_material', summary: 'Used 6 OSB boards' },
    })

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unresolvedFlags: [] }) }),
    )
  })

  it('correct with uncertaintyResolution:still_unsure copies flags from queue item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ uncertaintyFlags: ['conflicting_quantity'] }),
    )

    await postDecision({
      queueItemId: ITEM_ID, action: 'correct',
      uncertaintyResolution: 'still_unsure',
      corrected: { memoryType: 'used_material', summary: 'Used 6 OSB boards' },
    })

    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unresolvedFlags: ['conflicting_quantity'] }),
      }),
    )
  })
})

describe('review decisions — auto-total unit cost', () => {
  function orderedQueueItem(pm: any) {
    return makeQueueItem({
      sectionKey: 'ordered_materials',
      proposedMemory: { memoryType: 'ordered_material', summary: 'OSB', materialName: 'OSB', quantity: '5', unit: 'sheets', supplierName: null, deliveryTiming: null, locationOrUse: null, costAmount: '20', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '100', ...pm },
    })
  }

  it('confirm persists the derived total from proposed memory', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(orderedQueueItem({}))
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '100' }) }))
  })

  it('correct recalculates the total from corrected quantity × unit cost', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(orderedQueueItem({}))
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'ordered_material', summary: '10 OSB at £20 each', materialName: 'OSB', quantity: '10', unit: 'sheets', costAmount: '20', costCurrency: 'GBP', costQualifier: 'each' } })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '200' }) }))
  })

  it('correct with a conflicting explicit total keeps the item worth checking', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(orderedQueueItem({}))
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', uncertaintyResolution: 'resolved', corrected: { memoryType: 'ordered_material', summary: 'OSB', materialName: 'OSB', quantity: '5', unit: 'sheets', costAmount: '20', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '999' } })
    expect(res.statusCode).toBe(200)
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalCostAmount: '999', unresolvedFlags: expect.arrayContaining(['cost_uncertain']) }) }))
  })
})
