// GET /api/jobs/:jobId/memory-view — access control: unknown job and
// cross-user ownership failures.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  OTHER_USER_ID, MEMORY_VIEW_URL, AUTH_HEADERS,
  resetMemoryViewMocks, makeJob,
} from '../helpers/memory-view-test-builders.js'

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

describe('GET /api/jobs/:jobId/memory-view — access control', () => {
  it('returns 404 for unknown job', async () => {
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers: AUTH_HEADERS })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('JOB_NOT_FOUND')
  })

  it('returns 403 for cross-user job access', async () => {
    vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeJob({ ownerUserId: OTHER_USER_ID })
    )

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers: AUTH_HEADERS })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('FORBIDDEN')
  })
})
