import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadNote, isSupportedMimeType, normaliseMimeType } from '../src/services/notes.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { ErrorCode } from '../src/types/errors.js'

// Mock Prisma client
vi.mock('../src/db/client.js', () => {
  const JOB_ID = 'job-1'
  const USER_ID = 'user-1'

  const mockNote = {
    id: 'note-existing',
    clientNoteId: 'client-note-1',
    serverStatus: 'UPLOADED',
    audioObject: {},
  }

  const calls = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        rawNote: { create: vi.fn() },
        audioObject: { create: vi.fn() },
      }
      await fn(tx)
    }),
  }

  // Default: job exists and belongs to user; no existing note
  calls.findUnique.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    if (where.id === JOB_ID) return { id: JOB_ID, ownerUserId: USER_ID }
    if (where.jobId_clientNoteId) return null  // no duplicate by default
    return null
  })

  return {
    prisma: {
      job: { findUnique: calls.findUnique },
      rawNote: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: calls.findFirst,
        findMany: vi.fn().mockResolvedValue([]),
        create: calls.create,
      },
      audioObject: { create: vi.fn() },
      $transaction: calls.$transaction,
    },
    _calls: calls,
    _mockNote: mockNote,
    JOB_ID,
    USER_ID,
  }
})

const VALID_WEBM = Buffer.from('fake-webm-data')
const JOB_ID = 'job-1'
const USER_ID = 'user-1'

describe('isSupportedMimeType', () => {
  it('accepts audio/webm', () => {
    expect(isSupportedMimeType('audio/webm')).toBe(true)
  })

  it('accepts audio/webm;codecs=opus', () => {
    expect(isSupportedMimeType('audio/webm;codecs=opus')).toBe(true)
  })

  it('accepts audio/webm; codecs=opus with space', () => {
    expect(isSupportedMimeType('audio/webm; codecs=opus')).toBe(true)
  })

  it('rejects audio/mp4', () => {
    expect(isSupportedMimeType('audio/mp4')).toBe(false)
  })

  it('rejects audio/ogg', () => {
    expect(isSupportedMimeType('audio/ogg')).toBe(false)
  })

  it('rejects video/webm', () => {
    expect(isSupportedMimeType('video/webm')).toBe(false)
  })
})

describe('normaliseMimeType', () => {
  it('preserves audio/webm unchanged', () => {
    expect(normaliseMimeType('audio/webm')).toBe('audio/webm')
  })

  it('collapses space around semicolon', () => {
    expect(normaliseMimeType('audio/webm; codecs=opus')).toBe('audio/webm;codecs=opus')
  })

  it('trims surrounding whitespace', () => {
    expect(normaliseMimeType('  audio/webm  ')).toBe('audio/webm')
  })
})

describe('uploadNote', () => {
  let storage: FakeAudioStorage

  beforeEach(() => {
    storage = new FakeAudioStorage()
    vi.clearAllMocks()
  })

  it('rejects unsupported MIME type with AUDIO_UNSUPPORTED_TYPE', async () => {
    await expect(
      uploadNote(
        { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c1', capturedAt: new Date(), mimeType: 'audio/mp4', audioBuffer: VALID_WEBM },
        storage,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AUDIO_UNSUPPORTED_TYPE })
  })

  it('rejects oversized audio with AUDIO_TOO_LARGE', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024)
    await expect(
      uploadNote(
        { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c1', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: huge },
        storage,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AUDIO_TOO_LARGE })
  })

  it('stores audio and returns UPLOADED status on first upload', async () => {
    const { prisma } = await import('../src/db/client.js')

    // job lookup returns valid job
    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
      id: JOB_ID,
      ownerUserId: USER_ID,
      title: 'Test Job',
      jobType: 'test',
      status: 'ACTIVE',
      roughLocationOrLabel: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // no existing note
    vi.mocked(prisma.rawNote.findUnique).mockResolvedValueOnce(null)

    const result = await uploadNote(
      { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c-new', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: VALID_WEBM },
      storage,
    )

    expect(result.status).toBe('UPLOADED')
    expect(result.isDuplicate).toBe(false)
    expect(storage.stored.size).toBe(1)
  })

  it('returns existing note without re-storing on duplicate clientNoteId', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
      id: JOB_ID,
      ownerUserId: USER_ID,
      title: 'Test Job',
      jobType: 'test',
      status: 'ACTIVE',
      roughLocationOrLabel: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    vi.mocked(prisma.rawNote.findUnique).mockResolvedValueOnce({
      id: 'existing-note-id',
      clientNoteId: 'c-dup',
      jobId: JOB_ID,
      capturedAt: new Date(),
      uploadedAt: new Date(),
      mimeType: 'audio/webm',
      durationMs: null,
      sizeBytes: 100,
      serverStatus: 'UPLOADED',
      createdAt: new Date(),
      updatedAt: new Date(),
      audioObject: null,
    } as any)

    const result = await uploadNote(
      { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c-dup', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: VALID_WEBM },
      storage,
    )

    expect(result.isDuplicate).toBe(true)
    expect(result.noteId).toBe('existing-note-id')
    expect(storage.stored.size).toBe(0)
  })

  it('rejects access to another user\'s job with FORBIDDEN', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
      id: JOB_ID,
      ownerUserId: 'other-user',
      title: 'Test Job',
      jobType: 'test',
      status: 'ACTIVE',
      roughLocationOrLabel: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(
      uploadNote(
        { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c1', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: VALID_WEBM },
        storage,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN })
  })

  it('rejects non-existent job with JOB_NOT_FOUND', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce(null)

    await expect(
      uploadNote(
        { jobId: 'no-such-job', userId: USER_ID, clientNoteId: 'c1', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: VALID_WEBM },
        storage,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.JOB_NOT_FOUND })
  })

  it('handles concurrent duplicate: P2002 on DB insert → returns existing note, cleans up storage', async () => {
    const { prisma } = await import('../src/db/client.js')

    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
      id: JOB_ID, ownerUserId: USER_ID, title: 'T', jobType: 't',
      status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(),
    })
    vi.mocked(prisma.rawNote.findUnique)
      // First call (duplicate check): race window — returns null
      .mockResolvedValueOnce(null)
      // Second call (after P2002): fetch the winner
      .mockResolvedValueOnce({
        id: 'concurrent-winner',
        clientNoteId: 'c-race',
        jobId: JOB_ID,
        serverStatus: 'UPLOADED',
        capturedAt: new Date(), uploadedAt: new Date(),
        mimeType: 'audio/webm', durationMs: null, sizeBytes: 20,
        createdAt: new Date(), updatedAt: new Date(),
      } as any)

    // Transaction throws a P2002 unique constraint violation
    vi.mocked(prisma.$transaction).mockRejectedValueOnce({ code: 'P2002' })

    const result = await uploadNote(
      { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c-race', capturedAt: new Date(), mimeType: 'audio/webm', audioBuffer: VALID_WEBM },
      storage,
    )

    expect(result.isDuplicate).toBe(true)
    expect(result.noteId).toBe('concurrent-winner')
    // The orphaned audio file written before the DB failure should have been deleted
    expect(storage.stored.size).toBe(0)
  })

  it('preserves exact MIME type audio/webm;codecs=opus', async () => {
    const { prisma } = await import('../src/db/client.js')

    let capturedMimeType = ''
    vi.mocked(prisma.job.findUnique).mockResolvedValueOnce({
      id: JOB_ID, ownerUserId: USER_ID, title: 'T', jobType: 't',
      status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(),
    })
    vi.mocked(prisma.rawNote.findUnique).mockResolvedValueOnce(null)
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: any) => {
      const tx = {
        rawNote: {
          create: vi.fn().mockImplementation(({ data }: any) => {
            capturedMimeType = data.mimeType
            return {}
          }),
        },
        audioObject: { create: vi.fn() },
      }
      await fn(tx)
    })

    await uploadNote(
      { jobId: JOB_ID, userId: USER_ID, clientNoteId: 'c-opus', capturedAt: new Date(), mimeType: 'audio/webm;codecs=opus', audioBuffer: VALID_WEBM },
      storage,
    )

    expect(capturedMimeType).toBe('audio/webm;codecs=opus')
  })
})
