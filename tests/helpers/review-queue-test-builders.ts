// Shared builders + prisma mock for the review-queue HTTP test files
// (tests/review-queue/*). Mocked-prisma style: each builder returns a plain
// row shaped like the Prisma result the service reads, with explicit
// ownership (JOB_ID belongs to USER_ID) and overridable fields.
import { vi } from 'vitest'

export const USER_ID = 'queue-user-1'
export const OTHER_USER_ID = 'queue-other-user'
export const JOB_ID = 'queue-job-1'
export const NOTE_ID = 'queue-note-1'
export const NOTE_ID_2 = 'queue-note-2'
export const TX_ID = 'queue-tx-1'
export const TX_ID_2 = 'queue-tx-2'
export const FACT_ID = 'queue-fact-1'
export const FACT_ID_2 = 'queue-fact-2'
export const ITEM_ID = 'queue-item-1'
export const DECISION_ID = 'queue-decision-1'
export const MEMORY_ID = 'queue-memory-1'
export const CAT_TIMBER = 'cat-timber'
export const CAT_FIXINGS = 'cat-fixings'
export const CAT_LABOUR = 'cat-labour'

// Fixed "now" so time labels are deterministic in tests
export const NOW = new Date('2026-06-10T12:00:00.000Z')
export const TODAY_CAPTURE = new Date('2026-06-10T09:00:00.000Z')
export const YESTERDAY_CAPTURE = new Date('2026-06-09T09:00:00.000Z')
export const OLDER_CAPTURE = new Date('2026-06-05T09:00:00.000Z')

// Factory for the vi.mock('../../src/db/client.js') module. Call inside the
// mock callback so vi.fn instances are created per test file.
export function createReviewQueuePrismaMock() {
  const prisma: Record<string, any> = {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    rawNote: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    audioObject: { create: vi.fn() },
    transcript: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    candidateFact: { findMany: vi.fn(), updateMany: vi.fn() },
    reviewDecision: { create: vi.fn() },
    jobBudgetCategory: { findMany: vi.fn(), findFirst: vi.fn() },
    memoryItem: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    queueItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  }
  prisma.$transaction = vi
    .fn()
    .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma
}

// beforeEach defaults: authenticated USER_ID owning JOB_ID, empty queue state.
export async function resetReviewQueueMocks() {
  const { prisma } = await import('../../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.candidateFact.findMany as any).mockResolvedValue([])
  vi.mocked((prisma.candidateFact as any).updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(prisma.queueItem.deleteMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.createMany as any).mockResolvedValue({ count: 0 })
  vi.mocked(prisma.queueItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.queueItem.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.queueItem.update as any).mockResolvedValue({})
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue({ id: DECISION_ID })
  vi.mocked(prisma.jobBudgetCategory.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({
    ...makeMemoryItem(),
    ...data,
    id: MEMORY_ID,
  }))
  return prisma
}

export function makeUser(overrides?: object) {
  return {
    id: USER_ID,
    email: 'pilot@test.local',
    name: 'Pilot',
    role: 'PILOT',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

export function makeJob(overrides?: object) {
  return {
    id: JOB_ID,
    ownerUserId: USER_ID,
    title: 'Garden Room Build',
    jobType: 'construction',
    status: 'ACTIVE',
    roughLocationOrLabel: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

export function makeFact(overrides?: object) {
  return {
    id: FACT_ID,
    jobId: JOB_ID,
    sourceNoteId: NOTE_ID,
    sourceTranscriptId: TX_ID,
    factType: 'USED_MATERIAL',
    status: 'DRAFT',
    summary: 'Used OSB boards on the back wall',
    materialName: 'OSB',
    quantity: '6',
    unit: 'boards',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: 'back wall',
    confidenceLabel: 'MEDIUM',
    confidenceReason: 'Clear from context',
    uncertaintyFlags: [],
    happenedAt: null,
    extractionProvider: 'fake',
    extractionModel: null,
    extractionSchemaVersion: null,
    createdAt: TODAY_CAPTURE,
    updatedAt: TODAY_CAPTURE,
    sourceNote: { id: NOTE_ID, capturedAt: TODAY_CAPTURE },
    transcript: { id: TX_ID, text: 'Used six OSB boards on the back wall.' },
    ...overrides,
  }
}

export function makeFact2(overrides?: object) {
  return makeFact({
    id: FACT_ID_2,
    sourceNoteId: NOTE_ID_2,
    sourceTranscriptId: TX_ID_2,
    summary: 'Put OSB on back wall',
    sourceNote: { id: NOTE_ID_2, capturedAt: TODAY_CAPTURE },
    transcript: { id: TX_ID_2, text: 'Put OSB on back wall.' },
    ...overrides,
  })
}

export function makeQueueItem(overrides?: object) {
  return {
    id: ITEM_ID,
    jobId: JOB_ID,
    sectionKey: 'used_materials',
    kind: 'SINGLE',
    status: 'draft',
    reviewLabel: '',
    timeLabel: 'Today',
    summary: 'Used OSB boards on the back wall',
    proposedMemory: {
      memoryType: 'used_material',
      summary: 'Used OSB boards on the back wall',
      materialName: 'OSB',
      quantity: '6',
      unit: 'boards',
      supplierName: null,
      deliveryTiming: null,
      locationOrUse: 'back wall',
    },
    confidenceLabel: 'medium',
    uncertaintyFlags: [],
    sourceCandidateFactIds: [FACT_ID],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

export function makeMemoryItem(overrides?: object) {
  return {
    id: MEMORY_ID,
    jobId: JOB_ID,
    reviewDecisionId: DECISION_ID,
    sourceCandidateFactId: FACT_ID,
    memoryType: 'USED_MATERIAL',
    isManual: false,
    summary: 'Used OSB boards on the back wall',
    materialName: 'OSB',
    quantity: '6',
    unit: 'boards',
    supplierName: null,
    deliveryTiming: null,
    locationOrUse: 'back wall',
    happenedAt: null,
    unresolvedFlags: [],
    createdAt: TODAY_CAPTURE,
    updatedAt: TODAY_CAPTURE,
    ...overrides,
  }
}

export function makeBudgetCategory(overrides?: object) {
  return {
    id: CAT_TIMBER,
    jobId: JOB_ID,
    name: 'timber',
    budgetAmount: '4000',
    budgetCurrency: 'GBP',
    sortOrder: 0,
    isArchived: false,
    createdAt: new Date('2026-06-28T08:00:00.000Z'),
    updatedAt: new Date('2026-06-28T08:00:00.000Z'),
    ...overrides,
  }
}

// An ordered_material draft fact + matching queue item, used for suggestions.
export function makeOrderedFact(overrides?: object) {
  return makeFact({
    factType: 'ORDERED_MATERIAL',
    summary: 'Ordered a load of timber',
    materialName: 'timber',
    unit: 'load',
    ...overrides,
  })
}

export function makeOrderedQueueItem(overrides?: object) {
  return makeQueueItem({
    sectionKey: 'ordered_materials',
    summary: 'Ordered a load of timber',
    proposedMemory: {
      memoryType: 'ordered_material',
      summary: 'Ordered a load of timber',
      materialName: 'timber',
      quantity: '1',
      unit: 'load',
      supplierName: null,
      deliveryTiming: null,
      locationOrUse: null,
    },
    ...overrides,
  })
}

export function makeLabourQueueItem(overrides?: object) {
  return makeQueueItem({
    sectionKey: 'labour',
    summary: 'Tom did 8 hours on electrics at £35 an hour',
    proposedMemory: {
      memoryType: 'labour',
      summary: 'Tom did 8 hours on electrics at £35 an hour',
      materialName: null,
      quantity: null,
      unit: null,
      supplierName: null,
      deliveryTiming: null,
      locationOrUse: null,
      costAmount: '35',
      costCurrency: 'GBP',
      costQualifier: 'per_hour',
      totalCostAmount: '280',
      labourHours: '8',
      labourPerson: 'Tom',
      labourTask: 'electrics',
      happenedAt: '2026-06-09T11:00:00.000Z',
    },
    ...overrides,
  })
}
