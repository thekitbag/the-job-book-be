// GET /api/jobs/:jobId/review-queue — queue generation and read shape:
// sections, grouping (duplicates/contradictions/unclear), time labels,
// alreadyRemembered, stable item IDs, auth failures.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, OTHER_USER_ID, JOB_ID, NOTE_ID, TX_ID, FACT_ID, FACT_ID_2, ITEM_ID, MEMORY_ID,
  NOW, TODAY_CAPTURE,
  resetReviewQueueMocks, makeJob, makeFact, makeFact2, makeQueueItem, makeMemoryItem,
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

function getQueue() {
  return app.inject({
    method: 'GET',
    url: `/api/jobs/${JOB_ID}/review-queue`,
    headers: { 'x-pilot-user-id': USER_ID },
  })
}

describe('GET /api/jobs/:jobId/review-queue', () => {
  it('returns empty queue when no unresolved facts', async () => {
    const res = await getQueue()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.jobId).toBe(JOB_ID)
    expect(body.generatedAt).toBeDefined()
    expect(body.sections).toHaveLength(8)
    const totalItems = body.sections.reduce((n: number, s: any) => n + s.items.length, 0)
    expect(totalItems).toBe(0)
    expect(body.alreadyRemembered).toEqual([])
  })

  it('creates a single item for one DRAFT fact', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeQueueItem()])

    const res = await getQueue()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const usedSection = body.sections.find((s: any) => s.key === 'used_materials')
    expect(usedSection.items).toHaveLength(1)
    expect(usedSection.items[0].kind).toBe('single')
    expect(usedSection.items[0].status).toBe('draft')
    expect(usedSection.items[0].sourceCandidateFactIds).toEqual([FACT_ID])
  })

  it('item includes sourceContext with noteId, transcriptId, capturedAt, transcriptText', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([makeQueueItem()])

    const res = await getQueue()

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.sourceContext).toHaveLength(1)
    expect(item.sourceContext[0]).toMatchObject({
      candidateFactId: FACT_ID,
      noteId: NOTE_ID,
      transcriptId: TX_ID,
      transcriptText: 'Used six OSB boards on the back wall.',
    })
    expect(item.sourceContext[0].capturedAt).toBeDefined()
  })

  it('groups two same-name same-quantity facts as duplicate_group', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact(), makeFact2()])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ kind: 'DUPLICATE_GROUP', reviewLabel: 'Looks like the same item', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    ])

    const res = await getQueue()

    expect(res.statusCode).toBe(200)
    // Verify the grouping service passed a DUPLICATE_GROUP item to createMany
    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'DUPLICATE_GROUP')).toBe(true)

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.kind).toBe('duplicate_group')
    expect(item.reviewLabel).toBe('Looks like the same item')
    expect(item.sourceCandidateFactIds).toEqual([FACT_ID, FACT_ID_2])
  })

  it('groups same-name conflicting-quantity facts as contradiction', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
      makeFact({ quantity: '6' }),
      makeFact2({ quantity: '12' }),
    ])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ kind: 'CONTRADICTION', reviewLabel: 'Worth checking' }),
    ])

    const res = await getQueue()

    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'CONTRADICTION')).toBe(true)

    const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
    expect(item.kind).toBe('contradiction')
    expect(item.reviewLabel).toBe('Worth checking')
  })

  it('places UNCLEAR fact in unclear_items section as unclear_prompt', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
      makeFact({ factType: 'UNCLEAR', materialName: null, quantity: null }),
    ])
    vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
      makeQueueItem({ sectionKey: 'unclear_items', kind: 'UNCLEAR_PROMPT', reviewLabel: 'Needs clarification' }),
    ])

    const res = await getQueue()

    const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
    expect(callData.some((d: any) => d.kind === 'UNCLEAR_PROMPT')).toBe(true)

    const unclearSection = res.json().sections.find((s: any) => s.key === 'unclear_items')
    expect(unclearSection.items[0].kind).toBe('unclear_prompt')
  })

  it('assigns Today/Yesterday/Earlier time labels from capturedAt', async () => {
    vi.useFakeTimers({ now: NOW })
    try {
      vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([
        makeFact({ sourceNote: { id: NOTE_ID, capturedAt: TODAY_CAPTURE } }),
      ])
      vi.mocked(prisma.queueItem.findMany as any).mockResolvedValueOnce([
        makeQueueItem({ timeLabel: 'Today' }),
      ])

      const res = await getQueue()

      // Verify the service computed timeLabel='Today' when passing to createMany
      const callData = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data ?? []
      expect(callData[0]?.timeLabel).toBe('Today')

      const item = res.json().sections.find((s: any) => s.key === 'used_materials').items[0]
      expect(item.timeLabel).toBe('Today')
    } finally {
      vi.useRealTimers()
    }
  })

  it('deleteMany targets only stale DRAFT items, not decided items', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    await getQueue()

    const deleteCall = vi.mocked(prisma.queueItem.deleteMany as any).mock.calls[0]?.[0]
    expect(deleteCall.where.jobId).toBe(JOB_ID)
    expect(deleteCall.where.status).toBe('draft')
    // notIn constraint means decided (non-draft) items are never touched
    expect(deleteCall.where.id).toHaveProperty('notIn')
  })

  it('includes alreadyRemembered memory items', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([makeMemoryItem()])

    const res = await getQueue()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.alreadyRemembered).toHaveLength(1)
    expect(body.alreadyRemembered[0]).toMatchObject({
      memoryItemId: MEMORY_ID,
      summary: 'Used OSB boards on the back wall',
      memoryType: 'used_material',
    })
    expect(body.alreadyRemembered[0].timeLabel).toBeDefined()
  })

  it('alreadyRemembered includes structured fields for frontend display', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemoryItem({
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '30',
        unresolvedFlags: ['cost_uncertain'],
        sourceFact: { uncertaintyFlags: ['cost_uncertain'] },
      }),
    ])

    const res = await getQueue()

    const item = res.json().alreadyRemembered[0]
    expect(item.materialName).toBe('OSB')
    expect(item.quantity).toBe('6')
    expect(item.unit).toBe('boards')
    expect(item.locationOrUse).toBe('back wall')
    expect(item.costAmount).toBe('5')
    expect(item.costCurrency).toBe('GBP')
    expect(item.costQualifier).toBe('each')
    expect(item.totalCostAmount).toBe('30')
    expect(item.uncertaintyFlags).toEqual(['cost_uncertain'])
    expect(item.sourceUncertaintyFlags).toEqual(['cost_uncertain'])
  })

  it('alreadyRemembered uncertaintyFlags comes from unresolvedFlags (not sourceFact)', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemoryItem({
        unresolvedFlags: [],
        sourceFact: { uncertaintyFlags: ['material_uncertain'] },
      }),
    ])

    const res = await getQueue()

    const item = res.json().alreadyRemembered[0]
    expect(item.uncertaintyFlags).toEqual([])
    expect(item.sourceUncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('alreadyRemembered includes unitCostLabel and lineTotalLabel', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeMemoryItem({
        costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40',
        unresolvedFlags: [], sourceFact: null,
      }),
    ])

    const res = await getQueue()

    const item = res.json().alreadyRemembered[0]
    expect(item.unitCostLabel).toBe('£5 each')
    expect(item.lineTotalLabel).toBe('£40 total')
  })

  it('item ID is stable: createMany receives the same deterministic ID on consecutive GETs', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    // First GET
    await getQueue()
    const firstId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data?.[0]?.id

    // Second GET (simulating a concurrent refresh or page reload)
    await getQueue()
    const secondId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[1]?.[0]?.data?.[0]?.id

    expect(firstId).toBeDefined()
    expect(firstId).toBe(secondId)
  })

  it('decision submitted with ID from first GET succeeds after a second GET runs', async () => {
    vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([makeFact()])

    // First GET — capture the stable ID the service would pass to createMany
    await getQueue()
    const stableId = vi.mocked(prisma.queueItem.createMany as any).mock.calls[0]?.[0]?.data?.[0]?.id
    expect(stableId).toBeDefined()

    // Second GET happens on another device before Mike submits his decision
    await getQueue()

    // Decision using the ID from the first GET — findFirst finds the item (stable ID persists)
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem({ id: stableId }))

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${JOB_ID}/review-queue-decisions`,
      headers: { 'content-type': 'application/json', 'x-pilot-user-id': USER_ID },
      payload: { queueItemId: stableId, action: 'confirm' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().queueItemId).toBe(stableId)
  })

  it('returns 404 when job not found', async () => {
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(null)

    const res = await getQueue()

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'JOB_NOT_FOUND' })
  })

  it('returns 403 for another user job', async () => {
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await getQueue()

    expect(res.statusCode).toBe(403)
  })
})
