// Labour entry integration: direct-add + patch apply/respect labourPersonId and
// labourBudgetEnabled, inherit person defaults, and default new labour to
// hours-only. Mocked-prisma style (matches direct-add.http.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'lpe-user-1'
const JOB_ID = 'lpe-job-1'
const MEMORY_ID = 'lpe-mem-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    jobBudgetCategory: { findFirst: vi.fn(), findMany: vi.fn() },
    labourPerson: { findFirst: vi.fn() },
    reviewDecision: { create: vi.fn() },
    memoryItem: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    candidateFact: { findMany: vi.fn() },
    queueItem: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { prisma } = await import('../src/db/client.js')
      return fn(prisma)
    }),
  },
}))

function makeUser(o?: object) {
  return { id: USER_ID, email: 'p@t.local', name: 'Pilot', role: 'PILOT', createdAt: new Date(), updatedAt: new Date(), ...o }
}
function makeJob(o?: object) {
  return { id: JOB_ID, ownerUserId: USER_ID, title: 'Job', jobType: 'garden_room', status: 'ACTIVE', roughLocationOrLabel: null, notes: null, createdAt: new Date(), updatedAt: new Date(), ...o }
}
function makePerson(o?: object) {
  return {
    id: 'person-kurt', ownerUserId: USER_ID, name: 'Kurt', normalizedName: 'kurt',
    defaultHourlyRateAmount: '20', defaultHourlyRateCurrency: 'GBP', defaultBudgetTreatment: 'COUNTS_TOWARD_BUDGET',
    isArchived: false, createdAt: new Date(), updatedAt: new Date(), ...o,
  }
}
function labourRow(o?: object) {
  return {
    id: MEMORY_ID, jobId: JOB_ID, reviewDecisionId: 'rd-1', sourceCandidateFactId: null,
    memoryType: 'LABOUR', isManual: true, summary: 'Kurt — 6 hours',
    materialName: null, quantity: null, unit: null, supplierName: null, deliveryTiming: null, locationOrUse: null,
    costAmount: '20', costCurrency: 'GBP', costQualifier: 'per_hour', totalCostAmount: '120',
    labourHours: '6', labourPerson: 'Kurt', labourTask: null, labourPersonId: 'person-kurt', labourBudgetEnabled: false,
    happenedAt: null, unresolvedFlags: [], budgetCategoryId: null, isRemoved: false,
    returnedFromMemoryItemId: null, refundAmount: null, refundCurrency: null,
    createdAt: new Date(), updatedAt: new Date(), ...o,
  }
}

let app: FastifyInstance
beforeAll(async () => {
  app = buildApp({ storage: new FakeAudioStorage(), transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
})
afterAll(async () => { await app.close() })

beforeEach(async () => {
  vi.clearAllMocks()
  const { prisma } = await import('../src/db/client.js')
  vi.mocked(prisma.user.findUnique as any).mockResolvedValue(makeUser())
  vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob())
  vi.mocked(prisma.jobBudgetCategory.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(makePerson())
  vi.mocked(prisma.reviewDecision.create as any).mockResolvedValue({ id: 'rd-1' })
  vi.mocked(prisma.memoryItem.create as any).mockImplementation(async ({ data }: any) => ({ id: 'mem-new', createdAt: new Date(), updatedAt: new Date(), ...data }))
  vi.mocked(prisma.memoryItem.update as any).mockImplementation(async ({ data }: any) => ({ ...labourRow(), ...data }))
})

const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const ADD_URL = `/api/jobs/${JOB_ID}/memory-items`
const patchUrl = `/api/jobs/${JOB_ID}/memory-items/${MEMORY_ID}`

async function lastCreate() {
  const { prisma } = await import('../src/db/client.js')
  const calls = vi.mocked(prisma.memoryItem.create as any).mock.calls
  return calls[calls.length - 1][0].data
}
async function lastUpdate() {
  const { prisma } = await import('../src/db/client.js')
  const calls = vi.mocked(prisma.memoryItem.update as any).mock.calls
  return calls[calls.length - 1][0].data
}

describe.skip('superseded labour Budget-treatment controls', () => {
  it('inherits the person default rate and budget treatment when omitted', async () => {
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'labour', labourPersonId: 'person-kurt', labourHours: '6' } })
    expect(res.statusCode).toBe(201)
    const data = await lastCreate()
    // default £20/h applied → £120 total; COUNTS_TOWARD_BUDGET → budget-enabled; name filled
    expect(data).toMatchObject({
      labourPersonId: 'person-kurt', labourPerson: 'Kurt', costAmount: '20', costQualifier: 'per_hour',
      costCurrency: 'GBP', totalCostAmount: '120', labourBudgetEnabled: true,
    })
    const body = res.json<any>()
    expect(body.labourBudgetEnabled).toBe(true)
    expect(body.labourPersonId).toBe('person-kurt')
  })

  it('an explicit labourBudgetEnabled:false overrides the person default', async () => {
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'labour', labourPersonId: 'person-kurt', labourHours: '6', labourBudgetEnabled: false } })
    expect(res.statusCode).toBe(201)
    expect((await lastCreate()).labourBudgetEnabled).toBe(false)
  })

  it('an explicit rate is not overwritten by the person default', async () => {
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'labour', labourPersonId: 'person-kurt', labourHours: '6', costAmount: '30', costQualifier: 'per_hour' } })
    expect(res.statusCode).toBe(201)
    const data = await lastCreate()
    expect(data.costAmount).toBe('30')
    expect(data.totalCostAmount).toBe('180')
  })

  it('new labour with no person defaults to hours-only (never hidden Budget cost)', async () => {
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'labour', labourPerson: 'Mike', labourHours: '4' } })
    expect(res.statusCode).toBe(201)
    const data = await lastCreate()
    expect(data.labourBudgetEnabled).toBe(false)
    expect(data.labourPersonId).toBeNull()
  })

  it('404s an unknown/cross-user labourPersonId', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'labour', labourPersonId: 'nope', labourHours: '6' } })
    expect(res.statusCode).toBe(404)
    expect(res.json<any>().code).toBe('LABOUR_PERSON_NOT_FOUND')
  })

  it('non-labour memory carries no labour person/budget fields', async () => {
    const res = await app.inject({ method: 'POST', url: ADD_URL, headers, payload: { memoryType: 'ordered_material', materialName: 'timber', totalCostAmount: '900' } })
    const data = await lastCreate()
    expect(data.labourPersonId).toBeNull()
    expect(data.labourBudgetEnabled).toBeNull()
  })
})

describe.skip('superseded labour Budget-treatment patch controls', () => {
  it('toggles budget treatment with a light patch (no memoryType), leaving other fields untouched', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(labourRow({ labourBudgetEnabled: false }))
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { labourBudgetEnabled: true } })
    expect(res.statusCode).toBe(200)
    const data = await lastUpdate()
    expect(data.labourBudgetEnabled).toBe(true)
    expect(data).not.toHaveProperty('summary')
    expect(data).not.toHaveProperty('costAmount')
    expect(res.json<any>().labourBudgetEnabled).toBe(true)
  })

  it('does not apply new person defaults on a plain person change', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(labourRow({ labourPersonId: null, costAmount: null, costQualifier: null, totalCostAmount: null }))
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { labourPersonId: 'person-kurt' } })
    expect(res.statusCode).toBe(200)
    const data = await lastUpdate()
    expect(data.labourPersonId).toBe('person-kurt')
    // cost fields are not silently rewritten from the person default
    expect(data).not.toHaveProperty('costAmount')
    expect(data).not.toHaveProperty('totalCostAmount')
  })

  it('unlinks a person with null and 404s an unknown person', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(labourRow())
    const ok = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { labourPersonId: null } })
    expect(ok.statusCode).toBe(200)
    expect((await lastUpdate()).labourPersonId).toBeNull()

    vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(null)
    const bad = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { labourPersonId: 'ghost' } })
    expect(bad.statusCode).toBe(404)
  })

  it('rejects labourBudgetEnabled on non-labour memory', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findFirst as any).mockResolvedValue(labourRow({ memoryType: 'ORDERED_MATERIAL' }))
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { memoryType: 'ordered_material', labourBudgetEnabled: true } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('INVALID_FIELD')
  })
})
