// GET /api/jobs/:jobId/memory-view — summarySections: cost fields/labels on
// section items, summary-section shape, uncertainty flag sourcing, and
// like-for-like consolidation rules.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  MEMORY_ID, MEMORY_ID_2, MEMORY_VIEW_URL, AUTH_HEADERS,
  resetMemoryViewMocks, makeSourceFact, makeMemoryItem,
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

describe('GET /api/jobs/:jobId/memory-view — cost fields and summarySections', () => {
  const headers = AUTH_HEADERS

  it('includes cost fields and labels in section items', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ costAmount: '5', costCurrency: 'GBP', costQualifier: 'each', totalCostAmount: '40' }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].costAmount).toBe('5')
    expect(ordered?.items[0].costCurrency).toBe('GBP')
    expect(ordered?.items[0].costQualifier).toBe('each')
    expect(ordered?.items[0].totalCostAmount).toBe('40')
    expect(ordered?.items[0].unitCostLabel).toBe('£5 each')
    expect(ordered?.items[0].lineTotalLabel).toBe('£40 total')
  })

  it('includes summarySections with correct keys and labels', async () => {
    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; label: string; items: unknown[] }> }>()
    expect(body.summarySections).toHaveLength(3)
    expect(body.summarySections[0]).toMatchObject({ key: 'ordered_materials', label: 'Bought / ordered' })
    expect(body.summarySections[1]).toMatchObject({ key: 'used_materials', label: 'Used' })
    expect(body.summarySections[2]).toMatchObject({ key: 'leftovers', label: 'Leftovers' })
  })

  it('summarySections item has costLabel, totalCostLabel, memoryItemIds, and uncertaintyFlags', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '40',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [] }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].costLabel).toBe('£5 each')
    expect(ordered?.items[0].totalCostLabel).toBe('£40 total')
    expect(ordered?.items[0].memoryItemIds).toEqual([MEMORY_ID])
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
  })

  it('summarySections costLabel and totalCostLabel are null when no cost stored', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].costLabel).toBeNull()
    expect(ordered?.items[0].totalCostLabel).toBeNull()
  })

  it('section items uncertaintyFlags come from unresolvedFlags', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: ['material_uncertain'], sourceFact: makeSourceFact({ uncertaintyFlags: [] }) }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('section items sourceUncertaintyFlags come from sourceFact', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: [], sourceFact: makeSourceFact({ uncertaintyFlags: ['material_uncertain'] }) }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
    expect(ordered?.items[0].sourceUncertaintyFlags).toEqual(['material_uncertain'])
  })

  it('section items have empty uncertaintyFlags and sourceUncertaintyFlags when no sourceFact', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({ unresolvedFlags: [], sourceCandidateFactId: null, isManual: true, sourceFact: null }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ sections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.sections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items[0].uncertaintyFlags).toEqual([])
    expect(ordered?.items[0].sourceUncertaintyFlags).toEqual([])
  })
})

describe('GET /api/jobs/:jobId/memory-view — summarySections consolidation', () => {
  const headers = AUTH_HEADERS

  it('consolidates two compatible rows of same materialName + unit into one row', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].quantity).toBe('12')
    expect(ordered?.items[0].memoryItemIds).toEqual(expect.arrayContaining([MEMORY_ID, MEMORY_ID_2]))
    expect((ordered?.items[0].memoryItemIds as string[]).length).toBe(2)
  })

  it('keeps rows separate when units differ (bags vs sheets)', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '8',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'plasterboard',
        quantity: '4',
        unit: 'sheets',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when any item has unresolved flags', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        unresolvedFlags: ['approximate_quantity'],
        sourceFact: makeSourceFact({ uncertaintyFlags: ['approximate_quantity'], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when any quantity is non-numeric', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: 'some',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('merged row nulls out cost labels (items may have different unit costs)', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        costAmount: '5',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '40',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        costAmount: '6',
        costCurrency: 'GBP',
        costQualifier: 'each',
        totalCostAmount: '24',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].costLabel).toBeNull()
    expect(ordered?.items[0].totalCostLabel).toBeNull()
  })

  it('keeps rows separate when materialName is null even if unit matches', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: null,
        quantity: '3',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: null,
        quantity: '5',
        unit: 'bags',
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('keeps rows separate when unit is null even if materialName matches', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '3',
        unit: null,
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '5',
        unit: null,
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(2)
  })

  it('verified items (empty unresolvedFlags) consolidate even when sourceFact had flags', async () => {
    vi.mocked(prisma.memoryItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMemoryItem({
        id: MEMORY_ID,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '8',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: ['approximate_quantity'], factType: 'ORDERED_MATERIAL' }),
      }),
      makeMemoryItem({
        id: MEMORY_ID_2,
        memoryType: 'ORDERED_MATERIAL',
        materialName: 'hardcore',
        quantity: '4',
        unit: 'bags',
        unresolvedFlags: [],
        sourceFact: makeSourceFact({ uncertaintyFlags: [], factType: 'ORDERED_MATERIAL' }),
      }),
    ])

    const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers })

    const body = res.json<{ summarySections: Array<{ key: string; items: Array<Record<string, unknown>> }> }>()
    const ordered = body.summarySections.find((s) => s.key === 'ordered_materials')
    expect(ordered?.items).toHaveLength(1)
    expect(ordered?.items[0].quantity).toBe('12')
  })
})
