import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPilotPrepare } from '../src/scripts/pilot-prepare.js'
import type { PrepareOptions } from '../src/scripts/pilot-prepare.js'

// ── mock prisma ────────────────────────────────────────────────────────────────

function makeMockPrisma(overrides?: object) {
  return {
    user: { findUnique: vi.fn() },
    job: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    rawNote: { findMany: vi.fn(), deleteMany: vi.fn() },
    audioObject: { findMany: vi.fn(), deleteMany: vi.fn() },
    transcript: { count: vi.fn(), deleteMany: vi.fn() },
    candidateFact: { count: vi.fn(), deleteMany: vi.fn() },
    queueItem: { count: vi.fn(), deleteMany: vi.fn() },
    reviewDecision: { count: vi.fn(), deleteMany: vi.fn() },
    memoryItem: { count: vi.fn(), deleteMany: vi.fn() },
    ...overrides,
  } as unknown as import('@prisma/client').PrismaClient
}

const PILOT_USER_ID = 'usr-pilot-001'
const PILOT_EMAIL = 'mike@pilot.thejobbook.local'

const DEMO_JOB = { id: 'job-demo-001', title: 'Garden Room Build', status: 'ACTIVE' }
const DEMO_NOTE_ID = 'note-demo-001'
const DEMO_AUDIO_KEY = 'audio/job-demo-001/note-demo-001.webm'

function makeBaseOptions(overrides?: Partial<PrepareOptions>): PrepareOptions {
  return {
    dryRun: true,
    mode: 'empty',
    pilotUserId: PILOT_USER_ID,
    ...overrides,
  }
}

function wireUpPrismaDefaults(prisma: ReturnType<typeof makeMockPrisma>) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: PILOT_USER_ID, email: PILOT_EMAIL, name: 'Mike', role: 'PILOT',
    createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findMany).mockResolvedValue([DEMO_JOB])
  vi.mocked(prisma.rawNote.findMany).mockResolvedValue([{ id: DEMO_NOTE_ID }])
  vi.mocked(prisma.audioObject.findMany).mockResolvedValue([
    { id: 'ao-1', storageKey: DEMO_AUDIO_KEY, noteId: DEMO_NOTE_ID },
  ])
  vi.mocked(prisma.transcript.count).mockResolvedValue(2)
  vi.mocked(prisma.candidateFact.count).mockResolvedValue(5)
  vi.mocked(prisma.queueItem.count).mockResolvedValue(3)
  vi.mocked(prisma.reviewDecision.count).mockResolvedValue(2)
  vi.mocked(prisma.memoryItem.count).mockResolvedValue(1)
}

// ── validation ─────────────────────────────────────────────────────────────────

describe('runPilotPrepare — validation', () => {
  it('throws if pilot user is not found', async () => {
    const prisma = makeMockPrisma()
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    await expect(runPilotPrepare(makeBaseOptions(), { prisma })).rejects.toThrow('Pilot user not found')
  })

  it('throws for create-job mode with no title', async () => {
    const prisma = makeMockPrisma()
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: PILOT_USER_ID, email: PILOT_EMAIL, name: 'Mike', role: 'PILOT',
      createdAt: new Date(), updatedAt: new Date(),
    })

    await expect(
      runPilotPrepare(makeBaseOptions({ mode: 'create-job', title: '' }), { prisma })
    ).rejects.toThrow('--title is required')
  })

  it('throws for create-job mode with unknown job type', async () => {
    const prisma = makeMockPrisma()
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: PILOT_USER_ID, email: PILOT_EMAIL, name: 'Mike', role: 'PILOT',
      createdAt: new Date(), updatedAt: new Date(),
    })

    await expect(
      runPilotPrepare(
        makeBaseOptions({ mode: 'create-job', title: 'New Job', jobType: 'unknown_type' }),
        { prisma }
      )
    ).rejects.toThrow('--job-type must be one of')
  })
})

// ── dry-run ────────────────────────────────────────────────────────────────────

describe('runPilotPrepare — dry-run', () => {
  let prisma: ReturnType<typeof makeMockPrisma>

  beforeEach(() => {
    prisma = makeMockPrisma()
    wireUpPrismaDefaults(prisma)
  })

  it('returns correct counts without mutating any data', async () => {
    const result = await runPilotPrepare(makeBaseOptions({ dryRun: true }), { prisma })

    expect(result.dryRun).toBe(true)
    expect(result.counts.jobs).toBe(1)
    expect(result.counts.notes).toBe(1)
    expect(result.counts.audioObjects).toBe(1)
    expect(result.counts.transcripts).toBe(2)
    expect(result.counts.candidateFacts).toBe(5)
    expect(result.counts.queueItems).toBe(3)
    expect(result.counts.reviewDecisions).toBe(2)
    expect(result.counts.memoryItems).toBe(1)

    // No mutations
    expect(vi.mocked(prisma.job.deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.rawNote.deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.memoryItem.deleteMany)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.job.create)).not.toHaveBeenCalled()
  })

  it('lists R2 storage keys in dry-run without deleting', async () => {
    const deleteFromR2 = vi.fn()
    const result = await runPilotPrepare(
      makeBaseOptions({ dryRun: true }),
      { prisma, deleteFromR2 }
    )

    expect(result.r2StorageKeys).toContain(DEMO_AUDIO_KEY)
    expect(deleteFromR2).not.toHaveBeenCalled()
  })

  it('identifies jobs to clean and pilot user details', async () => {
    const result = await runPilotPrepare(makeBaseOptions({ dryRun: true }), { prisma })

    expect(result.pilotUserId).toBe(PILOT_USER_ID)
    expect(result.pilotUserEmail).toBe(PILOT_EMAIL)
    expect(result.jobsToClean).toHaveLength(1)
    expect(result.jobsToClean[0].title).toBe('Garden Room Build')
  })

  it('reports zero counts gracefully when pilot user has no jobs', async () => {
    vi.mocked(prisma.job.findMany).mockResolvedValue([])

    const result = await runPilotPrepare(makeBaseOptions({ dryRun: true }), { prisma })

    expect(result.counts.jobs).toBe(0)
    expect(result.counts.notes).toBe(0)
    expect(result.counts.audioObjects).toBe(0)
    expect(result.r2StorageKeys).toHaveLength(0)
    expect(result.jobsToClean).toHaveLength(0)
  })
})

// ── execute — empty mode ───────────────────────────────────────────────────────

describe('runPilotPrepare — execute — empty mode', () => {
  let prisma: ReturnType<typeof makeMockPrisma>

  beforeEach(() => {
    prisma = makeMockPrisma()
    wireUpPrismaDefaults(prisma)
    vi.mocked(prisma.memoryItem.deleteMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.queueItem.deleteMany).mockResolvedValue({ count: 3 })
    vi.mocked(prisma.reviewDecision.deleteMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.candidateFact.deleteMany).mockResolvedValue({ count: 5 })
    vi.mocked(prisma.transcript.deleteMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.audioObject.deleteMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.rawNote.deleteMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.job.deleteMany).mockResolvedValue({ count: 1 })
  })

  it('deletes all pilot jobs and downstream data, leaves pilot user', async () => {
    const result = await runPilotPrepare(makeBaseOptions({ dryRun: false, mode: 'empty' }), { prisma })

    expect(result.dryRun).toBe(false)

    // Pilot user must not be deleted
    expect(vi.mocked(prisma.user.findUnique)).toHaveBeenCalled()

    // Deletion called in dependency-safe order: memory → queue → decisions → facts → transcripts → audio → notes → jobs
    const deleteCalls = [
      prisma.memoryItem.deleteMany,
      prisma.queueItem.deleteMany,
      prisma.reviewDecision.deleteMany,
      prisma.candidateFact.deleteMany,
      prisma.transcript.deleteMany,
      prisma.audioObject.deleteMany,
      prisma.rawNote.deleteMany,
      prisma.job.deleteMany,
    ].map((fn) => vi.mocked(fn))
    for (const fn of deleteCalls) {
      expect(fn).toHaveBeenCalledOnce()
    }
  })

  it('deletes R2 objects and reports keys', async () => {
    const deleteFromR2 = vi.fn().mockResolvedValue(undefined)

    const result = await runPilotPrepare(
      makeBaseOptions({ dryRun: false, mode: 'empty' }),
      { prisma, deleteFromR2 }
    )

    expect(deleteFromR2).toHaveBeenCalledWith(DEMO_AUDIO_KEY)
    expect(result.r2Failures).toHaveLength(0)
  })

  it('records R2 failures without stopping DB deletion', async () => {
    const deleteFromR2 = vi.fn().mockRejectedValue(new Error('R2 unavailable'))

    const result = await runPilotPrepare(
      makeBaseOptions({ dryRun: false, mode: 'empty' }),
      { prisma, deleteFromR2 }
    )

    expect(result.r2Failures).toContain(DEMO_AUDIO_KEY)
    // DB deletion still ran
    expect(vi.mocked(prisma.job.deleteMany)).toHaveBeenCalled()
  })

  it('does not create a new job in empty mode', async () => {
    await runPilotPrepare(makeBaseOptions({ dryRun: false, mode: 'empty' }), { prisma })
    expect(vi.mocked(prisma.job.create)).not.toHaveBeenCalled()
  })

  it('handles pilot user with no jobs without error', async () => {
    vi.mocked(prisma.job.findMany).mockResolvedValue([])

    const result = await runPilotPrepare(makeBaseOptions({ dryRun: false, mode: 'empty' }), { prisma })

    expect(result.counts.jobs).toBe(0)
    expect(vi.mocked(prisma.job.deleteMany)).not.toHaveBeenCalled()
  })
})

// ── execute — create-job mode ─────────────────────────────────────────────────

describe('runPilotPrepare — execute — create-job mode', () => {
  let prisma: ReturnType<typeof makeMockPrisma>

  beforeEach(() => {
    prisma = makeMockPrisma()
    wireUpPrismaDefaults(prisma)
    vi.mocked(prisma.memoryItem.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.queueItem.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.reviewDecision.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.candidateFact.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.transcript.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.audioObject.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.rawNote.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.job.deleteMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.job.create).mockResolvedValue({
      id: 'new-job-001',
      title: 'Poole garden room',
      jobType: 'garden_room',
      status: 'ACTIVE',
      ownerUserId: PILOT_USER_ID,
      roughLocationOrLabel: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('cleans existing jobs then creates one new active job', async () => {
    const result = await runPilotPrepare(
      makeBaseOptions({ dryRun: false, mode: 'create-job', title: 'Poole garden room', jobType: 'garden_room' }),
      { prisma }
    )

    expect(vi.mocked(prisma.job.deleteMany)).toHaveBeenCalled()
    expect(vi.mocked(prisma.job.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Poole garden room',
          jobType: 'garden_room',
          ownerUserId: PILOT_USER_ID,
        }),
      })
    )
    expect(result.createdJob).toBeDefined()
    expect(result.createdJob!.title).toBe('Poole garden room')
    expect(result.createdJob!.jobType).toBe('garden_room')
  })

  it('trims whitespace from title', async () => {
    await runPilotPrepare(
      makeBaseOptions({ dryRun: false, mode: 'create-job', title: '  Poole garden room  ', jobType: 'garden_room' }),
      { prisma }
    )

    expect(vi.mocked(prisma.job.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Poole garden room' }) })
    )
  })

  it('defaults job type to other when not specified', async () => {
    vi.mocked(prisma.job.create).mockResolvedValue({
      id: 'new-job-002', title: 'First job', jobType: 'other', status: 'ACTIVE',
      ownerUserId: PILOT_USER_ID, roughLocationOrLabel: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    })

    await runPilotPrepare(
      makeBaseOptions({ dryRun: false, mode: 'create-job', title: 'First job' }),
      { prisma }
    )

    expect(vi.mocked(prisma.job.create)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobType: 'other' }) })
    )
  })
})
