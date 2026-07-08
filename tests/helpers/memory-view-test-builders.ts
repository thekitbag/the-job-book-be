// Shared builders + prisma mock for the memory-view HTTP test files
// (tests/memory-view/*). Mocked-prisma style: builders return rows shaped like
// the Prisma results the memory-view service reads, with explicit ownership
// (JOB_ID belongs to USER_ID) and overridable fields.
import { vi } from 'vitest'

export const USER_ID = 'mv-user-1'
export const OTHER_USER_ID = 'mv-other-user'
export const JOB_ID = 'mv-job-1'
export const NOTE_ID = 'mv-note-1'
export const TRANSCRIPT_ID = 'mv-tx-1'
export const FACT_ID = 'mv-fact-1'
export const DECISION_ID = 'mv-decision-1'
export const MEMORY_ID = 'mv-memory-1'
export const MEMORY_ID_2 = 'mv-memory-2'
export const MEMORY_ID_3 = 'mv-memory-3'
export const QUEUE_ITEM_ID = 'mv-qi-1'

export const MEMORY_VIEW_URL = `/api/jobs/${JOB_ID}/memory-view`
export const AUTH_HEADERS = { 'x-pilot-user-id': USER_ID }

// Factory for the vi.mock('../../src/db/client.js') module. Call inside the
// mock callback so vi.fn instances are created per test file.
export function createMemoryViewPrismaMock() {
  return {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    memoryItem: { findMany: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    queueItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    reviewDecision: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  }
}

// beforeEach defaults: authenticated USER_ID owning JOB_ID, one trusted memory
// item, no unresolved facts (empty fresh queue).
export async function resetMemoryViewMocks() {
  process.env.PILOT_USER_ID = USER_ID

  const { prisma } = await import('../../src/db/client.js')
  vi.mocked(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER_ID, email: 'pilot@test.local', name: 'Pilot', role: 'PILOT',
    createdAt: new Date(), updatedAt: new Date(),
  })
  vi.mocked(prisma.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeJob())
  vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeMemoryItem()])
  // buildFreshQueueSections defaults: no unresolved facts → empty queue
  vi.mocked(prisma.candidateFact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  vi.mocked(prisma.queueItem.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  return prisma
}

export function makeJob(overrides?: object) {
  return {
    id: JOB_ID,
    ownerUserId: USER_ID,
    title: 'Poole garden room',
    jobType: 'garden_room',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    ...overrides,
  }
}

export function makeSourceFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TRANSCRIPT_ID,
    factType: 'ORDERED_MATERIAL',
    status: 'CONFIRMED',
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: 'tomorrow morning',
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    uncertaintyFlags: [],
    createdAt: new Date('2026-06-13T08:55:00.000Z'),
    updatedAt: new Date('2026-06-13T08:55:00.000Z'),
    sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-13T08:55:00.000Z') },
    transcript: {
      id: TRANSCRIPT_ID,
      revision: 1,
      text: 'I ordered 12 sheets of plasterboard from Jewson.',
      status: 'COMPLETED',
      language: 'en',
      provider: 'openai',
      model: 'whisper-1',
      errorCode: null,
      extractionStatus: 'COMPLETED',
      extractionErrorCode: null,
    },
    ...overrides,
  }
}

export function makeMemoryItem(overrides?: object) {
  return {
    id: MEMORY_ID,
    jobId: JOB_ID,
    reviewDecisionId: DECISION_ID,
    sourceCandidateFactId: FACT_ID,
    memoryType: 'ORDERED_MATERIAL',
    isManual: false,
    summary: 'Ordered 12 sheets of plasterboard from Jewson',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: 'tomorrow morning',
    locationOrUse: null,
    unresolvedFlags: [],
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    sourceFact: makeSourceFact(),
    ...overrides,
  }
}

// A trusted labour memory item (hours-only by default; no sourceFact so the
// effective-day fallback is exercised explicitly via overrides).
export function makeLabourMemoryItem(overrides?: object) {
  return makeMemoryItem({
    memoryType: 'LABOUR',
    isManual: true,
    sourceCandidateFactId: null,
    sourceFact: null,
    summary: 'Mike — 4 hours',
    materialName: null,
    quantity: null,
    unit: null,
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: null,
    costAmount: null,
    costCurrency: null,
    costQualifier: null,
    totalCostAmount: null,
    labourHours: '4',
    labourPerson: 'Mike',
    labourTask: null,
    happenedAt: new Date('2026-06-12T11:00:00.000Z'),
    ...overrides,
  })
}

export function makeQueueItem(overrides?: object) {
  return {
    id: QUEUE_ITEM_ID,
    jobId: JOB_ID,
    sectionKey: 'ordered_materials',
    kind: 'SINGLE',
    status: 'draft',
    reviewLabel: '',
    timeLabel: 'Today',
    summary: 'Ordered 6 bricks',
    proposedMemory: {},
    confidenceLabel: 'high',
    uncertaintyFlags: [],
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date('2026-06-13T09:00:00.000Z'),
    updatedAt: new Date('2026-06-13T09:00:00.000Z'),
    ...overrides,
  }
}

// Fact shape expected by buildFreshQueueSections (includes sourceNote + transcript)
export function makeQueueFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TRANSCRIPT_ID,
    factType: 'ORDERED_MATERIAL',
    status: 'DRAFT',
    summary: 'Ordered 6 bricks',
    materialName: 'brick',
    quantity: '6',
    unit: null,
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: null,
    confidenceLabel: 'HIGH',
    uncertaintyFlags: [],
    sourceNote: { id: NOTE_ID, capturedAt: new Date('2026-06-13T09:00:00.000Z') },
    transcript: { id: TRANSCRIPT_ID, text: 'Ordered 6 bricks' },
    ...overrides,
  }
}
