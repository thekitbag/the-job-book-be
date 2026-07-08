// Labour Tracking V2: the authoritative labourHoursSummary on memory-view —
// UK-local-day grouping from happenedAt (with capture/created fallbacks),
// safe day/job hour totals, worth-checking visibility, and trusted line totals.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers/test-app.js'
import {
  USER_ID, MEMORY_VIEW_URL, AUTH_HEADERS,
  resetMemoryViewMocks, makeLabourMemoryItem, makeSourceFact,
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

async function getSummary() {
  const res = await app.inject({ method: 'GET', url: MEMORY_VIEW_URL, headers: AUTH_HEADERS })
  expect(res.statusCode).toBe(200)
  return res.json().labourHoursSummary
}

describe('memory-view — labourHoursSummary', () => {
  it('returns an empty summary when the job has no labour memory', async () => {
    const summary = await getSummary()
    expect(summary).toEqual({ totalHours: null, totalLabel: null, days: [] })
  })

  it('groups two labour items from the same day into one day with day and job totals', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ id: 'lab-mike', labourPerson: 'Mike', labourHours: '4' }),
      makeLabourMemoryItem({ id: 'lab-kurt', labourPerson: 'Kurt', labourHours: '6', summary: 'Kurt — 6 hours' }),
    ])
    const summary = await getSummary()
    expect(summary.days).toHaveLength(1)
    const day = summary.days[0]
    expect(day.date).toBe('2026-06-12')
    expect(day.totalHours).toBe('10')
    expect(day.totalLabel).toBe('10h day total')
    expect(day.items.map((i: any) => i.labourPerson).sort()).toEqual(['Kurt', 'Mike'])
    expect(summary.totalHours).toBe('10')
    expect(summary.totalLabel).toBe('10h job total')
  })

  it('orders days newest first and item fields carry hours label and happenedAt', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ id: 'lab-old', happenedAt: new Date('2026-06-10T11:00:00.000Z'), labourHours: '8' }),
      makeLabourMemoryItem({ id: 'lab-new', happenedAt: new Date('2026-06-12T11:00:00.000Z'), labourHours: '4' }),
    ])
    const summary = await getSummary()
    expect(summary.days.map((d: any) => d.date)).toEqual(['2026-06-12', '2026-06-10'])
    const item = summary.days[0].items[0]
    expect(item.memoryItemId).toBe('lab-new')
    expect(item.hoursLabel).toBe('4h')
    expect(item.happenedAt).toBe('2026-06-12T11:00:00.000Z')
    expect(item.includedInHourTotal).toBe(true)
    expect(item.worthChecking).toBe(false)
    expect(summary.totalHours).toBe('12')
  })

  it('groups by the UK local calendar day, not the UTC day', async () => {
    // 23:30 UTC on 11 June is 00:30 BST on 12 June
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ happenedAt: new Date('2026-06-11T23:30:00.000Z') }),
    ])
    const summary = await getSummary()
    expect(summary.days[0].date).toBe('2026-06-12')
  })

  it('falls back to the source note capture day when happenedAt is null', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({
        happenedAt: null,
        isManual: false,
        sourceFact: makeSourceFact({ sourceNote: { id: 'n', capturedAt: new Date('2026-06-09T08:00:00.000Z') } }),
      }),
    ])
    const summary = await getSummary()
    expect(summary.days[0].date).toBe('2026-06-09')
  })

  it('falls back to the created day for manual labour with no happenedAt', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ happenedAt: null, createdAt: new Date('2026-06-13T09:00:00.000Z') }),
    ])
    const summary = await getSummary()
    expect(summary.days[0].date).toBe('2026-06-13')
  })

  it('keeps non-numeric hours visible but excludes them from totals', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ id: 'lab-ok', labourHours: '4' }),
      makeLabourMemoryItem({ id: 'lab-approx', labourHours: 'about 6', summary: 'About 6 hours' }),
      makeLabourMemoryItem({ id: 'lab-none', labourHours: null, summary: 'Kurt on site' }),
    ])
    const summary = await getSummary()
    const day = summary.days[0]
    expect(day.items).toHaveLength(3)
    expect(day.totalHours).toBe('4')
    const approx = day.items.find((i: any) => i.memoryItemId === 'lab-approx')
    expect(approx.includedInHourTotal).toBe(false)
    expect(approx.labourHours).toBe('about 6')
    const none = day.items.find((i: any) => i.memoryItemId === 'lab-none')
    expect(none.includedInHourTotal).toBe(false)
    expect(none.hoursLabel).toBeNull()
  })

  it('keeps worth-checking labour visible but out of hour totals when the flags touch the hours', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ id: 'lab-flagged', labourHours: '6', unresolvedFlags: ['approximate_quantity'] }),
    ])
    const summary = await getSummary()
    const item = summary.days[0].items[0]
    expect(item.worthChecking).toBe(true)
    expect(item.includedInHourTotal).toBe(false)
    expect(summary.days[0].totalHours).toBeNull()
    expect(summary.totalHours).toBeNull()
  })

  it('still counts hours when the only unresolved flag is cost_uncertain', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ labourHours: '6', unresolvedFlags: ['cost_uncertain'] }),
    ])
    const summary = await getSummary()
    const item = summary.days[0].items[0]
    expect(item.worthChecking).toBe(true)
    expect(item.includedInHourTotal).toBe(true)
    expect(summary.days[0].totalHours).toBe('6')
  })

  it('supports fractional hours in totals', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({ id: 'a', labourHours: '3.5' }),
      makeLabourMemoryItem({ id: 'b', labourHours: '4' }),
    ])
    const summary = await getSummary()
    expect(summary.days[0].totalHours).toBe('7.5')
    expect(summary.totalLabel).toBe('7.5h job total')
  })

  it('exposes trusted line totals for rated labour and null for hours-only labour', async () => {
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      makeLabourMemoryItem({
        id: 'lab-rated', labourHours: '8', labourPerson: 'Tom', labourTask: 'electrics',
        costAmount: '35', costCurrency: 'GBP', costQualifier: 'per_hour', totalCostAmount: '280',
      }),
      makeLabourMemoryItem({ id: 'lab-hours-only' }),
    ])
    const summary = await getSummary()
    const rated = summary.days[0].items.find((i: any) => i.memoryItemId === 'lab-rated')
    expect(rated.lineTotalAmount).toBe('280')
    expect(rated.lineTotalCurrency).toBe('GBP')
    expect(rated.lineTotalLabel).toBe('£280 total')
    expect(rated.labourTask).toBe('electrics')
    const hoursOnly = summary.days[0].items.find((i: any) => i.memoryItemId === 'lab-hours-only')
    expect(hoursOnly.lineTotalAmount).toBeNull()
    expect(hoursOnly.lineTotalLabel).toBeNull()
  })
})
