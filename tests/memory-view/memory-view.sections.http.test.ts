// GET /api/jobs/:jobId/memory-view — trusted-section grouping and read shape:
// eight sections, corrected values shown over originals, source context,
// draft/stillToCheck separation, job summary metadata.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  JOB_ID, NOTE_ID, TRANSCRIPT_ID, FACT_ID, MEMORY_VIEW_URL, AUTH_HEADERS,
  resetMemoryViewMocks, makeSourceFact, makeMemoryItem, makeQueueItem, makeQueueFact,
} from '../helpers/memory-view-test-builders.js'
import { computeQueueItemId } from '../../src/services/review-queue.js'

vi.mock('../../src/db/client.js', async () => {
  const { createMemoryViewPrismaMock } = await import('../helpers/memory-view-test-builders.js')
  return { prisma: createMemoryViewPrismaMock() }
})

let app: FastifyInstance
let prisma: Awaited<ReturnType<typeof resetMemoryViewMocks>>

beforeAll(async () => {
  app = buildTestApp()
  await app.ready()
})

afterAll(() => app.close())

beforeEach(async () => {
  vi.clearAllMocks()
  prisma = await resetMemoryViewMocks()
})

describe('GET /api/jobs/:jobId/memory-view — response shape', () => {
  const headers = AUTH_HEADERS

  it('returns all nine trusted-memory sections', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ sections: Array<{ key: string }> }>()
    const keys = body.sections.map((s) => s.key)
    expect(keys).toEqual([
      'ordered_materials',
      'used_materials',
      'leftovers',
      'returned_materials',
      'supplier_delivery_notes',
      'customer_changes',
      'watch_outs',
      'labour',
      'general_notes',
    ])
  })

  it('places confirmed memory into the correct section', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: unknown[] }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    const usedMaterials = body.sections.find((s) => s.key === 'used_materials')
    expect(usedMaterials?.items).toHaveLength(0)
  })

  it('shows corrected memory using accepted memory item fields, not original candidate text', async () => {
    // Memory item has corrected values that differ from the source candidate
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        memoryType: 'USED_MATERIAL',
        summary: 'Corrected: used 10 sheets of OSB board',
        materialName: 'OSB board',
        quantity: '10',
        sourceFact: makeSourceFact({
          factType: 'USED_MATERIAL',
          summary: 'Original: plasterboard',
          materialName: 'plasterboard',
        }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<{ summary: string; materialName: string }> }> }>()
    const used = body.sections.find((s) => s.key === 'used_materials')
    expect(used?.items[0].summary).toBe('Corrected: used 10 sheets of OSB board')
    expect(used?.items[0].materialName).toBe('OSB board')
  })

  it('includes budgetCategoryId on section items', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ budgetCategoryId: 'cat-timber' }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<{ budgetCategoryId: string | null }> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].budgetCategoryId).toBe('cat-timber')
  })

  it('returns normalized lowercase memoryType and job status', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ job: { status: string }; sections: Array<{ key: string; items: Array<{ memoryType: string }> }> }>()
    expect(body.job.status).toBe('active')
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].memoryType).toBe('ordered_material')
  })

  it('includes source context when sourceCandidateFactId exists', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: Array<{ source: Record<string, unknown> | null }> }> }>()
    const source = body.sections[0].items[0].source
    expect(source).not.toBeNull()
    expect(source!.candidateFactId).toBe(FACT_ID)
    expect(source!.noteId).toBe(NOTE_ID)
    expect(source!.transcriptId).toBe(TRANSCRIPT_ID)
    expect(typeof source!.capturedAt).toBe('string')
    expect(source!.transcriptText).toBe('I ordered 12 sheets of plasterboard from Jewson.')
  })

  it('returns source: null for manual memory with no source fact', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ sourceCandidateFactId: null, isManual: true, sourceFact: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: Array<{ source: null }> }> }>()
    expect(body.sections[0].items[0].source).toBeNull()
  })

  it('draft candidate facts do not appear in trusted sections', async () => {
    // Only a draft candidate fact exists — no memory items
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeQueueFact({ status: 'DRAFT' }),
    ])
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ items: unknown[] }> }>()
    const totalItems = body.sections.reduce((sum, s) => sum + s.items.length, 0)
    expect(totalItems).toBe(0)
  })

  it('unresolved draft queue items appear in stillToCheck, not in trusted sections', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeQueueFact({ status: 'DRAFT' }),
    ])
    vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeQueueItem()])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{
      sections: Array<{ items: unknown[] }>
      stillToCheck: { count: number; items: Array<{ id: string; sectionKey: string; summary: string; kind: string }> }
    }>()
    const totalTrusted = body.sections.reduce((sum, s) => sum + s.items.length, 0)
    expect(totalTrusted).toBe(0)
    expect(body.stillToCheck.count).toBe(1)
    // still-to-check items are derived read-only from unresolved facts, with
    // the same deterministic id a review-queue GET would return
    expect(body.stillToCheck.items[0].id).toBe(computeQueueItemId(JOB_ID, [FACT_ID]))
    expect(body.stillToCheck.items[0].sectionKey).toBe('ordered_materials')
    expect(body.stillToCheck.items[0].kind).toBe('single')
  })

  it('GET memory-view performs no queue_items writes (read-only invariant)', async () => {
    vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeQueueFact({ status: 'DRAFT' }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    expect(res.statusCode).toBe(200)
    expect(prisma.queueItem.deleteMany).not.toHaveBeenCalled()
    expect(prisma.queueItem.createMany).not.toHaveBeenCalled()
  })

  it('stillToCheck count is 0 when no unresolved work exists', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ stillToCheck: { count: number; items: unknown[] } }>()
    expect(body.stillToCheck.count).toBe(0)
    expect(body.stillToCheck.items).toHaveLength(0)
  })

  it('includes generatedAt timestamp and normalized job summary', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ generatedAt: string; job: { id: string; title: string; jobType: string } }>()
    expect(typeof body.generatedAt).toBe('string')
    expect(body.job.id).toBe(JOB_ID)
    expect(body.job.title).toBe('Poole garden room')
    expect(body.job.jobType).toBe('garden_room')
  })
})
