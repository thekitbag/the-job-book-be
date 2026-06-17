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

// ── pilot correction guard integration ────────────────────────────────────────

describe('runExtraction — pilot correction guard', () => {
  it("persists Jewson (guarded) when provider returns Duesen's with high confidence", async () => {
    const { prisma } = await import('../src/db/client.js')
    // Transcript with strong order context so the guard can correct the mishear
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: "Ordered twenty bags of sand from Duesen's for Monday." }),
    )

    const duesensProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'ordered_material' as const,
          summary: "Ordered twenty bags of sand from Duesen's for Monday.",
          materialName: 'sand',
          quantity: '20',
          unit: 'bags',
          supplierName: "Duesen's",
          deliveryTiming: 'Monday',
          confidenceLabel: 'high' as const,
          confidenceReason: "Explicit in transcript",
          uncertaintyFlags: [],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, duesensProvider)

    const calls = vi.mocked(prisma.candidateFact.create as any).mock.calls
    expect(calls).toHaveLength(1)
    const data = calls[0][0].data
    // Guard should have corrected Duesen's → Jewson at medium confidence
    expect(data.supplierName).toBe('Jewson')
    expect(data.confidenceLabel).toBe('MEDIUM')
    expect(data.uncertaintyFlags).toContain('supplier_uncertain')
  })

  it('raw transcript text is not modified by the guard', async () => {
    const { prisma } = await import('../src/db/client.js')
    const originalText = "Ordered twenty bags of sand from Duesen's for Monday."
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: originalText }),
    )

    const duesensProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{ factType: 'ordered_material' as const, summary: 'test', supplierName: "Duesen's", confidenceLabel: 'high' as const, confidenceReason: 'test', uncertaintyFlags: [] }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, duesensProvider)

    // Transcript text update calls must not contain altered text
    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    for (const update of txUpdates) {
      if ('text' in update) {
        expect(update.text).toBe(originalText)
      }
    }
    // candidateFact rows still link to original transcript
    const factCall = vi.mocked(prisma.candidateFact.create as any).mock.calls[0]
    expect(factCall[0].data.sourceTranscriptId).toBe(TRANSCRIPT_ID)
  })

  it('extraction failure behaviour is unchanged when provider throws', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: "Ordered bags of sand from Duesen's." }),
    )

    const failingProvider = {
      name: 'stub-fail',
      model: 'stub-v1',
      extractFacts: async () => { throw new Error('provider down') },
    }

    await runExtraction(TRANSCRIPT_ID, failingProvider)

    const txUpdates = vi.mocked(prisma.transcript.update as any).mock.calls.map((c: any) => c[0].data)
    expect(txUpdates).toContainEqual(expect.objectContaining({ extractionStatus: 'FAILED' }))
    expect(vi.mocked(prisma.candidateFact.create as any)).not.toHaveBeenCalled()
  })
})

// ── cost fields ───────────────────────────────────────────────────────────────

describe('runExtraction — cost field persistence and safe total derivation', () => {
  it('persists cost fields and derives total from 8 × £5 each', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: 'Bought 8 bags of hardcore from Jewson at £5 each.' }),
    )

    const costProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'ordered_material' as const,
          summary: 'Bought 8 bags of hardcore from Jewson at £5 each',
          materialName: 'hardcore',
          quantity: '8',
          unit: 'bags',
          supplierName: 'Jewson',
          costAmount: '5',
          costCurrency: 'GBP',
          costQualifier: 'each' as const,
          confidenceLabel: 'high' as const,
          confidenceReason: 'Explicit in transcript',
          uncertaintyFlags: [],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, costProvider)

    const data = vi.mocked(prisma.candidateFact.create as any).mock.calls[0][0].data
    expect(data.costAmount).toBe('5')
    expect(data.costCurrency).toBe('GBP')
    expect(data.costQualifier).toBe('each')
    expect(data.totalCostAmount).toBe('40')
  })

  it('derives total from non-integer unit cost: 12 × £8.50 = £102', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: 'Bought 12 sheets at £8.50 each.' }),
    )

    const costProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'ordered_material' as const,
          summary: 'Bought 12 sheets at £8.50 each',
          quantity: '12',
          unit: 'sheets',
          costAmount: '8.50',
          costCurrency: 'GBP',
          costQualifier: 'each' as const,
          confidenceLabel: 'high' as const,
          confidenceReason: 'Explicit',
          uncertaintyFlags: [],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, costProvider)

    const data = vi.mocked(prisma.candidateFact.create as any).mock.calls[0][0].data
    expect(data.totalCostAmount).toBe('102')
  })

  it('does not derive total when qualifier is approx; preserves cost_uncertain flag', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: 'About £40 of hardcore.' }),
    )

    const costProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'ordered_material' as const,
          summary: 'About £40 of hardcore',
          materialName: 'hardcore',
          costAmount: '40',
          costCurrency: 'GBP',
          costQualifier: 'approx' as const,
          confidenceLabel: 'medium' as const,
          confidenceReason: 'Approximate',
          uncertaintyFlags: ['cost_uncertain'],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, costProvider)

    const data = vi.mocked(prisma.candidateFact.create as any).mock.calls[0][0].data
    expect(data.costAmount).toBe('40')
    expect(data.costQualifier).toBe('approx')
    expect(data.totalCostAmount).toBeNull()
    expect(data.uncertaintyFlags).toContain('cost_uncertain')
  })

  it('preserves provider-returned totalCostAmount for explicit total cost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: 'Bought 8 bags of hardcore for £40.' }),
    )

    const costProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'ordered_material' as const,
          summary: 'Bought 8 bags of hardcore for £40',
          materialName: 'hardcore',
          quantity: '8',
          unit: 'bags',
          costAmount: '40',
          costCurrency: 'GBP',
          costQualifier: 'total' as const,
          totalCostAmount: '40',
          confidenceLabel: 'high' as const,
          confidenceReason: 'Explicit',
          uncertaintyFlags: [],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, costProvider)

    const data = vi.mocked(prisma.candidateFact.create as any).mock.calls[0][0].data
    expect(data.costQualifier).toBe('total')
    expect(data.totalCostAmount).toBe('40')
  })

  it('persists null cost fields for facts with no cost information', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.transcript.findUnique as any).mockResolvedValueOnce(
      makeTranscript({ text: 'Used 6 OSB boards on the back wall.' }),
    )

    const noCostProvider = {
      name: 'stub',
      model: 'stub-v1',
      extractFacts: async () => ({
        facts: [{
          factType: 'used_material' as const,
          summary: 'Used 6 OSB boards on the back wall',
          materialName: 'OSB',
          quantity: '6',
          unit: 'boards',
          confidenceLabel: 'high' as const,
          confidenceReason: 'Explicit',
          uncertaintyFlags: [],
        }],
        schemaVersion: 'v1',
      }),
    }

    await runExtraction(TRANSCRIPT_ID, noCostProvider)

    const data = vi.mocked(prisma.candidateFact.create as any).mock.calls[0][0].data
    expect(data.costAmount).toBeNull()
    expect(data.costCurrency).toBeNull()
    expect(data.costQualifier).toBeNull()
    expect(data.totalCostAmount).toBeNull()
  })
})
