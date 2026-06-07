import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runTranscription } from '../src/transcription/worker.js'
import { FakeTranscriptionProvider, FailingTranscriptionProvider, FAKE_TRANSCRIPT_TEXT } from '../src/transcription/fake.js'
import { FakeAudioStorage } from './fakes/storage.js'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    rawNote: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    transcript: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}))

const NOTE_ID = 'worker-note-1'
const STORAGE_KEY = `notes/job-1/${NOTE_ID}.webm`
const AUDIO_DATA = Buffer.from('fake-webm-bytes')

function makeNote(overrides?: object) {
  return {
    id: NOTE_ID,
    jobId: 'job-1',
    clientNoteId: 'c1',
    mimeType: 'audio/webm',
    serverStatus: 'UPLOADED',
    audioObject: { storageKey: STORAGE_KEY, bucket: 'fake', mimeType: 'audio/webm', sizeBytes: AUDIO_DATA.byteLength },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runTranscription — success path', () => {
  it('creates a transcript row, calls provider, and marks note TRANSCRIBED', async () => {
    const { prisma } = await import('../src/db/client.js')
    const storage = new FakeAudioStorage()
    await storage.store(STORAGE_KEY, AUDIO_DATA, 'audio/webm')

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValueOnce(makeNote())
    vi.mocked(prisma.transcript.create as any).mockResolvedValueOnce({ id: 'tx-success' })

    await runTranscription(NOTE_ID, new FakeTranscriptionProvider(), storage)

    // Transcript created with TRANSCRIBING status
    expect(vi.mocked(prisma.transcript.create as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ noteId: NOTE_ID, status: 'TRANSCRIBING' }),
      }),
    )

    // Transcript updated to COMPLETED with text
    expect(vi.mocked(prisma.transcript.update as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED', text: FAKE_TRANSCRIPT_TEXT }),
      }),
    )

    // Note updated to TRANSCRIBED
    const noteUpdates = vi.mocked(prisma.rawNote.update as any).mock.calls.map((c: any) => c[0].data.serverStatus)
    expect(noteUpdates).toContain('TRANSCRIBING')
    expect(noteUpdates).toContain('TRANSCRIBED')
  })
})

describe('runTranscription — failure path', () => {
  it('marks transcript FAILED and note FAILED while preserving raw note row', async () => {
    const { prisma } = await import('../src/db/client.js')
    const storage = new FakeAudioStorage()
    await storage.store(STORAGE_KEY, AUDIO_DATA, 'audio/webm')

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValueOnce(makeNote())
    vi.mocked(prisma.transcript.create as any).mockResolvedValueOnce({ id: 'tx-fail' })

    await runTranscription(NOTE_ID, new FailingTranscriptionProvider(), storage)

    // Transcript updated to FAILED
    expect(vi.mocked(prisma.transcript.update as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'PROVIDER_ERROR' }),
      }),
    )

    // Note updated to FAILED
    const noteUpdates = vi.mocked(prisma.rawNote.update as any).mock.calls.map((c: any) => c[0].data.serverStatus)
    expect(noteUpdates).toContain('FAILED')

    // Raw note findUnique was called but never deleted — audio in storage is intact
    expect(storage.stored.has(STORAGE_KEY)).toBe(true)
  })

  it('does not delete the audio object on failure', async () => {
    const { prisma } = await import('../src/db/client.js')
    const storage = new FakeAudioStorage()
    await storage.store(STORAGE_KEY, AUDIO_DATA, 'audio/webm')

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValueOnce(makeNote())
    vi.mocked(prisma.transcript.create as any).mockResolvedValueOnce({ id: 'tx-nodelete' })

    await runTranscription(NOTE_ID, new FailingTranscriptionProvider(), storage)

    expect(storage.stored.has(STORAGE_KEY)).toBe(true)
  })
})

describe('runTranscription — missing data guard', () => {
  it('returns early when note is not found', async () => {
    const { prisma } = await import('../src/db/client.js')
    const storage = new FakeAudioStorage()

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValueOnce(null)

    await runTranscription('no-such-note', new FakeTranscriptionProvider(), storage)

    expect(vi.mocked(prisma.transcript.create as any)).not.toHaveBeenCalled()
  })

  it('returns early when note has no audio object', async () => {
    const { prisma } = await import('../src/db/client.js')
    const storage = new FakeAudioStorage()

    vi.mocked(prisma.rawNote.findUnique as any).mockResolvedValueOnce(makeNote({ audioObject: null }))

    await runTranscription(NOTE_ID, new FakeTranscriptionProvider(), storage)

    expect(vi.mocked(prisma.transcript.create as any)).not.toHaveBeenCalled()
  })
})
