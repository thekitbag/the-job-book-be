import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runExtraction } from '../src/extraction/worker.js'
import {
  FakeExtractionProvider,
  FailingExtractionProvider,
  FAKE_EXTRACTION_FACTS,
  FAKE_EXTRACTION_SCHEMA_VERSION,
} from '../src/extraction/fake.js'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    transcript: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    rawNote: {
      update: vi.fn().mockResolvedValue({}),
    },
    candidateFact: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

const TRANSCRIPT_ID = 'tx-worker-1'
const NOTE_ID = 'note-worker-1'
const JOB_ID = 'job-worker-1'

function makeTranscript(overrides?: object) {
  return {
    id: TRANSCRIPT_ID,
    noteId: NOTE_ID,
    status: 'COMPLETED',
    text: 'Ordered 12 sheets of plasterboard from Jewson. There are probably three insulation packs left.',
    extractionStatus: null,
    note: {
      id: NOTE_ID,
      jobId: JOB_ID,
      serverStatus: 'TRANSCRIBED',
      job: { id: JOB_ID, title: 'Garden Room Build', jobType: 'construction' },
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runExtraction — success path', () => {
  it('creates one candidateFact row per extracted fact', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).toHaveBeenCalledTimes(FAKE_EXTRACTION_FACTS.length)
  })

  it('deletes prior facts for transcript before inserting new ones', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.deleteMany as any)).toHaveBeenCalledWith({
      where: { sourceTranscriptId: TRANSCRIPT_ID },
    })
  })

  it('persists ordered_material fact with correct fields', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    const calls = vi.mocked(prisma.candidateFact.create as any).mock.calls
    const orderedCall = calls.find((c: any) => c[0].data.factType === 'ORDERED_MATERIAL')
    expect(orderedCall).toBeDefined()
    expect(orderedCall[0].data).toMatchObject({
      jobId: JOB_ID,
      sourceNoteId: NOTE_ID,
      sourceTranscriptId: TRANSCRIPT_ID,
      factType: 'ORDERED_MATERIAL',
      status: 'DRAFT',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
      supplierName: 'Jewson',
      confidenceLabel: 'HIGH',
      uncertaintyFlags: [],
      extractionSchemaVersion: FAKE_EXTRACTION_SCHEMA_VERSION,
    })
  })

  it('persists leftover_material fact with LOW confidence and uncertainty flags', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    const calls = vi.mocked(prisma.candidateFact.create as any).mock.calls
    const leftoverCall = calls.find((c: any) => c[0].data.factType === 'LEFTOVER_MATERIAL')
    expect(leftoverCall).toBeDefined()
    expect(leftoverCall[0].data).toMatchObject({
      factType: 'LEFTOVER_MATERIAL',
      status: 'DRAFT',
      confidenceLabel: 'LOW',
      uncertaintyFlags: ['approximate_quantity'],
    })
  })

  it('marks transcript extractionStatus COMPLETED and note EXTRACTED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    expect(txUpdates).toContainEqual(expect.objectContaining({ extractionStatus: 'EXTRACTING' }))
    expect(txUpdates).toContainEqual(expect.objectContaining({ extractionStatus: 'COMPLETED' }))

    const noteUpdates = vi.mocked(prisma.rawNote.update as any).mock.calls.map((c: any) => c[0].data.serverStatus)
    expect(noteUpdates).toContain('EXTRACTING')
    expect(noteUpdates).toContain('EXTRACTED')
  })

  it('produces zero facts without error when provider returns empty array', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    const emptyProvider = {
      name: 'empty',
      model: 'empty-v1',
      extractFacts: async () => ({ facts: [], schemaVersion: 'v1' }),
    }

    await runExtraction(TRANSCRIPT_ID, emptyProvider)

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    expect(txUpdates).toContainEqual(expect.objectContaining({ extractionStatus: 'COMPLETED' }))
  })
})

describe('runExtraction — failure path', () => {
  it('marks extractionStatus FAILED without touching transcript transcription status', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FailingExtractionProvider())

    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    // extractionStatus → FAILED, but status (transcription) is never updated
    expect(txUpdates).toContainEqual(
      expect.objectContaining({ extractionStatus: 'FAILED' }),
    )
    // Transcription status field must never be set to FAILED during extraction
    const hasBadTranscriptUpdate = txUpdates.some((d: any) => 'status' in d && d.status === 'FAILED')
    expect(hasBadTranscriptUpdate).toBe(false)
  })

  it('records the provider error code on transcript', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FailingExtractionProvider())

    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    const failUpdate = txUpdates.find((d: any) => d.extractionStatus === 'FAILED')
    expect(failUpdate?.extractionErrorCode).toBe('EXTRACTION_PROVIDER_ERROR')
  })

  it('returns note to TRANSCRIBED (not FAILED) after extraction failure', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FailingExtractionProvider())

    const noteUpdates = vi.mocked(prisma.rawNote.update as any).mock.calls.map((c: any) => c[0].data.serverStatus)
    expect(noteUpdates).not.toContain('FAILED')
    expect(noteUpdates).toContain('TRANSCRIBED')
  })

  it('does not create any candidateFact rows on failure', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(makeTranscript())

    await runExtraction(TRANSCRIPT_ID, new FailingExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
  })
})

describe('runExtraction — guard conditions', () => {
  it('returns early when transcript is not found', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(null)

    await runExtraction('no-such-transcript', new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.transcript.update as any)).not.toHaveBeenCalled()
  })

  it('returns early when transcript status is not COMPLETED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ status: 'TRANSCRIBING' }),
    )

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
  })

  it('returns early when extractionStatus is already COMPLETED', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ extractionStatus: 'COMPLETED' }),
    )

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.transcript.update as any)).not.toHaveBeenCalled()
  })

  it('returns early when extractionStatus is EXTRACTING (in-flight)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ extractionStatus: 'EXTRACTING' }),
    )

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.transcript.update as any)).not.toHaveBeenCalled()
  })

  it('returns early when transcript text is null', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: null }),
    )

    await runExtraction(TRANSCRIPT_ID, new FakeExtractionProvider())

    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
  })
})
