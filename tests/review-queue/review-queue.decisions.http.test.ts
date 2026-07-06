// POST /api/jobs/:jobId/review-queue-decisions — core decision behaviour:
// request validation, confirm/correct/dismiss outcomes, group handling,
// already-decided and confirm-not-allowed conflicts, ownership failure.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, OTHER_USER_ID, JOB_ID, FACT_ID, FACT_ID_2, ITEM_ID, MEMORY_ID,
  resetReviewQueueMocks, makeJob, makeQueueItem,
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

describe('POST /api/jobs/:jobId/review-queue-decisions', () => {
  it('returns 400 when queueItemId is missing', async () => {
    const res = await postDecision({ action: 'confirm' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when action is missing', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when action is unknown', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'reject' })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when correct missing corrected.summary', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'used_material' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 when correct missing corrected.memoryType', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', corrected: { summary: 'Some summary' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'MISSING_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.memoryType is unclear', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'unclear', summary: 'Some summary' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 400 INVALID_FIELD when corrected.memoryType is unknown', async () => {
    const res = await postDecision({ queueItemId: ITEM_ID, action: 'correct', corrected: { memoryType: 'banana', summary: 'Some summary' } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('returns 404 when queue item not found', async () => {
    const res = await postDecision({ queueItemId: 'nonexistent', action: 'confirm' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_NOT_FOUND' })
  })

  it('returns 409 when item already decided', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem({ status: 'confirmed' }))

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_ALREADY_DECIDED' })
  })

  it('returns 409 when confirming a contradiction item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'CONTRADICTION', status: 'draft' }),
    )

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_CONFIRM_NOT_ALLOWED' })
  })

  it('returns 409 when confirming an unclear_prompt item', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'UNCLEAR_PROMPT', status: 'draft' }),
    )

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'QUEUE_ITEM_CONFIRM_NOT_ALLOWED' })
  })

  it('confirm: creates memory from proposedMemory and marks source facts CONFIRMED', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('confirm')
    expect(body.status).toBe('confirmed')
    expect(body.memoryItemId).toBe(MEMORY_ID)
    expect(body.sourceCandidateFactIds).toEqual([FACT_ID])

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'QUEUE_CONFIRM', jobId: JOB_ID }) }),
    )
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memoryType: 'USED_MATERIAL', summary: 'Used OSB boards on the back wall' }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CONFIRMED' },
    })
  })

  it('confirm: groups with multiple source facts update all of them', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })

    expect(res.statusCode).toBe(200)
    expect(res.json().sourceCandidateFactIds).toEqual([FACT_ID, FACT_ID_2])
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID, FACT_ID_2] } },
      data: { status: 'CONFIRMED' },
    })
  })

  it('correct: creates memory with corrected fields and marks facts CORRECTED', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: {
        memoryType: 'used_material',
        summary: 'Used eight OSB boards on the back wall',
        quantity: '8',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('correct')
    expect(body.status).toBe('corrected')
    expect(body.memoryItemId).toBeDefined()

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'QUEUE_CORRECT' }) }),
    )
    expect(prisma.memoryItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: 'Used eight OSB boards on the back wall',
          quantity: '8',
          memoryType: 'USED_MATERIAL',
        }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'CORRECTED' },
    })
  })

  it('confirm on duplicate group preserves both source fact IDs on the review decision', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
        }),
      }),
    )
  })

  it('dismiss on duplicate group preserves both source fact IDs on the review decision', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'DUPLICATE_GROUP', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    await postDecision({ queueItemId: ITEM_ID, action: 'dismiss' })

    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceCandidateFactIds: [FACT_ID, FACT_ID_2],
        }),
      }),
    )
  })

  it('contradiction can be corrected into memory', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(
      makeQueueItem({ kind: 'CONTRADICTION', sourceCandidateFactIds: [FACT_ID, FACT_ID_2] }),
    )

    const res = await postDecision({
      queueItemId: ITEM_ID,
      action: 'correct',
      corrected: { memoryType: 'used_material', summary: 'Used twelve OSB boards', quantity: '12' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().action).toBe('correct')
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID, FACT_ID_2] } },
      data: { status: 'CORRECTED' },
    })
  })

  it('dismiss: no memory created, marks facts REJECTED', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'dismiss', reason: 'Not about this job' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.action).toBe('dismiss')
    expect(body.status).toBe('dismissed')
    expect(body.memoryItemId).toBeNull()

    expect(prisma.memoryItem.create).not.toHaveBeenCalled()
    expect(prisma.reviewDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'QUEUE_DISMISS', reason: 'Not about this job' }),
      }),
    )
    expect(prisma.candidateFact.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [FACT_ID] } },
      data: { status: 'REJECTED' },
    })
  })

  it('dismiss without reason still succeeds', async () => {
    vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(makeQueueItem())

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'dismiss' })
    expect(res.statusCode).toBe(200)
    expect(res.json().action).toBe('dismiss')
  })

  it('returns 403 for decision on another user job', async () => {
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: OTHER_USER_ID }))

    const res = await postDecision({ queueItemId: ITEM_ID, action: 'confirm' })
    expect(res.statusCode).toBe(403)
  })
})
