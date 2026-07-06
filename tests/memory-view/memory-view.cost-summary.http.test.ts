// GET /api/jobs/:jobId/memory-view — costSummary: known-spend inclusion rules,
// missing/uncertain cost classification, row consolidation, and excludedRows
// (reasons, labels, set/count invariants).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  MEMORY_ID, MEMORY_ID_2, MEMORY_ID_3, MEMORY_VIEW_URL, AUTH_HEADERS,
  resetMemoryViewMocks, makeMemoryItem,
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

describe('GET /api/jobs/:jobId/memory-view — costSummary', () => {
  const headers = AUTH_HEADERS

  it('returns costSummary with orderedMaterials key', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: unknown } }>()
    expect(body.costSummary).toBeDefined()
    expect(body.costSummary.orderedMaterials).toBeDefined()
  })

  it('includes a trusted ordered-material item with totalCostAmount and GBP in known spend', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('40')
    expect(om.knownSpendCurrency).toBe('GBP')
    expect(om.knownSpendLabel).toBe('£40 known spend')
    expect(om.includedMemoryItemIds).toEqual([MEMORY_ID])
    expect(om.missingCostCount).toBe(0)
    expect(om.uncertainCostCount).toBe(0)
    expect(om.excludedMemoryItemIds).toEqual([])
  })

  it('sums GBP line totals from multiple trusted items', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_2, memoryType: 'ORDERED_MATERIAL', totalCostAmount: '60', costCurrency: 'GBP', unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('100')
    expect(om.knownSpendLabel).toBe('£100 known spend')
  })

  it('excludes item with unresolved flags from known spend as uncertainCost', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: ['cost_uncertain'],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.uncertainCostCount).toBe(1)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID)
  })

  it('item with cost_uncertain from unresolvable conflict is excluded from known spend', async () => {
    // Regression: uncertaintyResolution:'resolved' on a conflicting PATCH must not clear cost_uncertain,
    // and any item that still carries cost_uncertain must be excluded here regardless of how it got the flag.
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        quantity: '8', costAmount: '5', costCurrency: 'GBP', costQualifier: 'each',
        totalCostAmount: '45',          // conflicts with 8 × £5 = £40
        unresolvedFlags: ['cost_uncertain'],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const om = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
      .costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.uncertainCostCount).toBe(1)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID)
  })

  it('counts item with no costAmount or totalCostAmount as missingCost', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(0)
  })

  it('counts item with costAmount but no totalCostAmount as uncertainCost', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: '5', totalCostAmount: null, costQualifier: 'approx', unresolvedFlags: [] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.missingCostCount).toBe(0)
    expect(om.uncertainCostCount).toBe(1)
  })

  it('excludes non-ordered-material memory types from costSummary', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'USED_MATERIAL',
        totalCostAmount: '100',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.includedMemoryItemIds).toEqual([])
    expect(om.missingCostCount).toBe(0)
  })

  it('returns knownSpendAmount:null when no trusted ordered-material items', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBeNull()
    expect(om.knownSpendLabel).toBeNull()
    expect(om.rows).toEqual([])
  })

  it('rows include a single trusted item as a row with lineTotalLabel', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        totalCostAmount: '600',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    const rows = body.costSummary.orderedMaterials.rows
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('plasterboard|sheets')
    expect(rows[0].materialName).toBe('plasterboard')
    expect(rows[0].quantity).toBe('12')
    expect(rows[0].unit).toBe('sheets')
    expect(rows[0].lineTotalAmount).toBe('600')
    expect(rows[0].lineTotalCurrency).toBe('GBP')
    expect(rows[0].lineTotalLabel).toBe('£600 total')
    expect(rows[0].memoryItemIds).toEqual([MEMORY_ID])
  })

  it('rows consolidate two like-for-like trusted items (same material + unit)', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        totalCostAmount: '20',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>>; knownSpendAmount: string } } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.rows).toHaveLength(1)
    expect(om.rows[0].quantity).toBe('12')
    expect(om.rows[0].lineTotalAmount).toBe('60')
    expect(om.rows[0].lineTotalLabel).toBe('£60 total')
    expect((om.rows[0].memoryItemIds as string[])).toHaveLength(2)
    expect(om.knownSpendAmount).toBe('60')
  })

  it('rows do not consolidate items with different units', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'plasterboard',
        quantity: '8',
        unit: 'bags',
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '4',
        unit: 'sheets',
        totalCostAmount: '80',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    expect(body.costSummary.orderedMaterials.rows).toHaveLength(2)
  })

  it('rows do not consolidate when unit is null', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: 'hardcore',
        quantity: '8',
        unit: null,
        totalCostAmount: '40',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: null,
        totalCostAmount: '20',
        costCurrency: 'GBP',
        unresolvedFlags: [],
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: { rows: Array<Record<string, unknown>> } } }>()
    expect(body.costSummary.orderedMaterials.rows).toHaveLength(2)
  })

  it('separate the known spend total from an item with missing cost', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_2, memoryType: 'ORDERED_MATERIAL', totalCostAmount: null, costAmount: null, unresolvedFlags: [] }),
      makeMemoryItem({ id: MEMORY_ID_3, memoryType: 'ORDERED_MATERIAL', totalCostAmount: '30', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ costSummary: { orderedMaterials: Record<string, unknown> } }>()
    const om = body.costSummary.orderedMaterials
    expect(om.knownSpendAmount).toBe('40')
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(1)
    expect((om.includedMemoryItemIds as string[])).toEqual([MEMORY_ID])
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID_2)
    expect((om.excludedMemoryItemIds as string[])).toContain(MEMORY_ID_3)
  })
})

// ── costSummary.orderedMaterials.excludedRows ─────────────────────────────────

type ExcludedRow = {
  memoryItemId: string
  itemLabel: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  reason: 'no_cost_remembered' | 'cost_worth_checking'
}

type OrderedMaterials = {
  knownSpendAmount: string | null
  includedMemoryItemIds: string[]
  missingCostCount: number
  uncertainCostCount: number
  excludedMemoryItemIds: string[]
  rows: Array<{ memoryItemIds: string[] }>
  excludedRows: ExcludedRow[]
}

describe('GET /api/jobs/:jobId/memory-view — costSummary.excludedRows', () => {
  const headers = AUTH_HEADERS

  async function getOrderedMaterials(): Promise<OrderedMaterials> {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })
    return res.json<{ costSummary: { orderedMaterials: OrderedMaterials } }>()
      .costSummary.orderedMaterials
  }

  it('keeps an included trusted item out of excludedRows', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toEqual([])
    expect(om.rows.flatMap((r) => r.memoryItemIds)).toEqual([MEMORY_ID])
  })

  it('classifies a missing-cost item as no_cost_remembered', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0]).toMatchObject({
      memoryItemId: MEMORY_ID,
      reason: 'no_cost_remembered',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
    })
  })

  it('classifies an ambiguous-basis item (costAmount, no safe total) as cost_worth_checking', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, costAmount: '5', totalCostAmount: null, costQualifier: 'approx', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('classifies an unresolved-flag item as cost_worth_checking', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('classifies a non-GBP trusted line total as cost_worth_checking', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, totalCostAmount: '40', costCurrency: 'EUR', unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.knownSpendAmount).toBeNull()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].reason).toBe('cost_worth_checking')
  })

  it('falls back to summary for itemLabel when materialName is absent', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: null,
        summary: 'Ordered some bits and bobs',
        costAmount: null,
        totalCostAmount: null,
        unresolvedFlags: [],
      }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows[0].itemLabel).toBe('Ordered some bits and bobs')
    expect(om.excludedRows[0].materialName).toBeNull()
  })

  it('uses a safe generic itemLabel when both materialName and summary are blank/whitespace', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        materialName: '   ',
        summary: '  \t  ',
        costAmount: null,
        totalCostAmount: null,
        unresolvedFlags: [],
      }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toHaveLength(1)
    expect(om.excludedRows[0].itemLabel).toBe('Bought item')
    expect((om.excludedRows[0].itemLabel as string).trim().length).toBeGreaterThan(0)
  })

  it('excludes non-ordered-material memory types from excludedRows', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ id: MEMORY_ID, memoryType: 'USED_MATERIAL', costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
    ])

    const om = await getOrderedMaterials()
    expect(om.excludedRows).toEqual([])
  })

  it('holds set and count invariants on a mixed fixture', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      // included GBP line total
      makeMemoryItem({ id: MEMORY_ID, materialName: 'hardcore', unit: 'bags', totalCostAmount: '404', costCurrency: 'GBP', unresolvedFlags: [] }),
      // missing cost
      makeMemoryItem({ id: MEMORY_ID_2, materialName: 'plasterboard', unit: 'sheets', costAmount: null, totalCostAmount: null, unresolvedFlags: [] }),
      // worth checking (unresolved flag)
      makeMemoryItem({ id: MEMORY_ID_3, materialName: 'insulation', unit: 'packs', totalCostAmount: '50', costCurrency: 'GBP', unresolvedFlags: ['cost_uncertain'] }),
    ])

    const om = await getOrderedMaterials()

    // one excluded row per excluded item, with the right reasons
    const byId = Object.fromEntries(om.excludedRows.map((r) => [r.memoryItemId, r.reason]))
    expect(byId[MEMORY_ID_2]).toBe('no_cost_remembered')
    expect(byId[MEMORY_ID_3]).toBe('cost_worth_checking')

    // counts derived from excludedRows
    expect(om.missingCostCount).toBe(1)
    expect(om.uncertainCostCount).toBe(1)

    // excludedMemoryItemIds equals the excluded row IDs (order-independent)
    expect([...om.excludedMemoryItemIds].sort()).toEqual([...om.excludedRows.map((r) => r.memoryItemId)].sort())

    // includedMemoryItemIds equals the flattened included row IDs
    expect([...om.includedMemoryItemIds].sort()).toEqual([...om.rows.flatMap((r) => r.memoryItemIds)].sort())

    // every trusted item appears exactly once across rows + excludedRows
    const allIds = [...om.rows.flatMap((r) => r.memoryItemIds), ...om.excludedRows.map((r) => r.memoryItemId)]
    expect(allIds.sort()).toEqual([MEMORY_ID, MEMORY_ID_2, MEMORY_ID_3].sort())
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})
