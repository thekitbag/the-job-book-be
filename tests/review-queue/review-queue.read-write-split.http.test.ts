// Real-DB regression tests for the queue read/write split: GET review-queue,
// GET memory-view, and the inspection read derive the queue without touching
// queue_items; the decision POST materialises the derived row first, so ids
// returned by a GET stay decidable even when no queue_items row ever existed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { prisma } from '../../src/db/client.js'
import { FakeAudioStorage } from '../fakes/storage.js'
import { FakeTranscriptionProvider } from '../../src/transcription/fake.js'
import { FakeExtractionProvider } from '../../src/extraction/fake.js'

const EMAIL = 'queue-split@test.local'
const INSPECTION_KEY = 'split-inspection-key-24chars!!!'

let app: FastifyInstance
let userId: string
let jobId: string
let savedKey: string | undefined

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } })
  if (!user) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: user.id } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: user.id } })
}

// One unresolved candidate fact with full source context; NO queue_items row —
// exactly the state existing pilot data can be in now that GET no longer
// materialises the queue.
async function createUnresolvedFact(summary: string, materialName: string) {
  const note = await prisma.rawNote.create({
    data: { jobId, clientNoteId: randomUUID(), capturedAt: new Date(), mimeType: 'audio/webm', sizeBytes: 10 },
  })
  const tx = await prisma.transcript.create({
    data: { noteId: note.id, status: 'COMPLETED', text: summary },
  })
  return prisma.candidateFact.create({
    data: {
      jobId, sourceNoteId: note.id, sourceTranscriptId: tx.id,
      factType: 'ORDERED_MATERIAL', status: 'DRAFT', summary, materialName,
      quantity: '2', unit: 'bags', confidenceLabel: 'MEDIUM', confidenceReason: 'r',
      uncertaintyFlags: [],
    },
  })
}

const headers = () => ({ 'x-pilot-user-id': userId })

beforeAll(async () => {
  savedKey = process.env.INTERNAL_INSPECTION_KEY
  process.env.INTERNAL_INSPECTION_KEY = INSPECTION_KEY
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  const user = await prisma.user.create({ data: { email: EMAIL, name: 'Split' } })
  userId = user.id
})

afterAll(async () => {
  await cleanup()
  await app.close()
  if (savedKey === undefined) delete process.env.INTERNAL_INSPECTION_KEY
  else process.env.INTERNAL_INSPECTION_KEY = savedKey
})

beforeEach(async () => {
  // Fresh job per test so queue_items counts are isolated
  const job = await prisma.job.create({ data: { ownerUserId: userId, title: 'Split job', jobType: 'garden_room' } })
  jobId = job.id
})

const countQueueRows = () => prisma.queueItem.count({ where: { jobId } })

describe('read endpoints are read-only with respect to queue_items', () => {
  it('GET /review-queue returns unresolved facts but writes no queue_items rows', async () => {
    await createUnresolvedFact('Ordered 2 bags of cement', 'cement')
    expect(await countQueueRows()).toBe(0)

    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: headers() })

    expect(res.statusCode).toBe(200)
    const ordered = res.json().sections.find((s: any) => s.key === 'ordered_materials')
    expect(ordered.items).toHaveLength(1)
    expect(ordered.items[0].summary).toBe('Ordered 2 bags of cement')
    // still no persisted rows: derivation only
    expect(await countQueueRows()).toBe(0)
  })

  it('GET /memory-view stillToCheck reflects unresolved facts without writing queue_items', async () => {
    await createUnresolvedFact('Ordered 2 bags of sand', 'sand')

    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/memory-view`, headers: headers() })

    expect(res.statusCode).toBe(200)
    expect(res.json().stillToCheck.count).toBe(1)
    expect(await countQueueRows()).toBe(0)
  })

  it('inspection read derives queue sections without writing queue_items', async () => {
    await createUnresolvedFact('Ordered 2 bags of gravel', 'gravel')

    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/pilot/jobs/${jobId}/inspection`,
      headers: { ...headers(), 'x-internal-inspection-key': INSPECTION_KEY },
    })

    expect(res.statusCode).toBe(200)
    const ordered = res.json().queue.sections.find((s: any) => s.key === 'ordered_materials')
    expect(ordered.items).toHaveLength(1)
    expect(await countQueueRows()).toBe(0)
  })
})

describe('decision write path materialises the derived queue', () => {
  it('POST decision succeeds for a GET-returned id when no queue_items row existed', async () => {
    await createUnresolvedFact('Ordered 2 bags of plaster', 'plaster')

    const get = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: headers() })
    const item = get.json().sections.find((s: any) => s.key === 'ordered_materials').items[0]
    expect(await countQueueRows()).toBe(0) // GET persisted nothing

    const post = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/review-queue-decisions`,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: { queueItemId: item.id, action: 'confirm' },
    })

    expect(post.statusCode).toBe(200)
    expect(post.json()).toMatchObject({ queueItemId: item.id, action: 'confirm', status: 'confirmed' })

    // Audit trail persisted by the write path: decided queue row + decision + memory
    const row = await prisma.queueItem.findUnique({ where: { id: item.id } })
    expect(row?.status).toBe('confirmed')
    const memory = await prisma.memoryItem.findMany({ where: { jobId } })
    expect(memory).toHaveLength(1)
    expect(memory[0].summary).toBe('Ordered 2 bags of plaster')
    const fact = await prisma.candidateFact.findFirst({ where: { jobId } })
    expect(fact?.status).toBe('CONFIRMED')
  })

  it('a decided item cannot be decided again after later GETs and decisions', async () => {
    await createUnresolvedFact('Ordered 2 bags of lime', 'lime')
    const get = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: headers() })
    const item = get.json().sections.find((s: any) => s.key === 'ordered_materials').items[0]

    const first = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/review-queue-decisions`,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: { queueItemId: item.id, action: 'dismiss' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/review-queue-decisions`,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: { queueItemId: item.id, action: 'dismiss' },
    })
    // The fact is resolved, so the item is no longer derivable and its draft row
    // was consumed by the first decision.
    expect([404, 409]).toContain(second.statusCode)
  })

  it('stale draft rows are cleaned up by the decision write path, not by GET', async () => {
    const fact = await createUnresolvedFact('Ordered 2 bags of grout', 'grout')

    // A stale draft row left over from the old GET-materialisation era, whose
    // source fact is no longer unresolved.
    const staleId = randomUUID()
    await prisma.queueItem.create({
      data: {
        id: staleId, jobId, sectionKey: 'ordered_materials', kind: 'SINGLE', status: 'draft',
        reviewLabel: '', summary: 'stale row', proposedMemory: {}, uncertaintyFlags: [],
        sourceCandidateFactIds: ['gone-fact'],
      },
    })

    // GET must not delete it (read-only)…
    await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: headers() })
    expect(await prisma.queueItem.findUnique({ where: { id: staleId } })).not.toBeNull()

    // …but the decision write path syncs the queue and removes it.
    const get = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: headers() })
    const item = get.json().sections.find((s: any) => s.key === 'ordered_materials').items[0]
    expect(item.sourceCandidateFactIds).toEqual([fact.id])
    const post = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/review-queue-decisions`,
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: { queueItemId: item.id, action: 'confirm' },
    })
    expect(post.statusCode).toBe(200)
    expect(await prisma.queueItem.findUnique({ where: { id: staleId } })).toBeNull()
  })
})
