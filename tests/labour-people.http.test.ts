// Labour people endpoints: GET (with per-job stats), POST, PATCH — validation,
// duplicate-name rejection, ownership, and person defaults. Mocked-prisma style.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const USER_ID = 'lp-user-1'
const JOB_ID = 'lp-job-1'

vi.mock('../src/db/client.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    labourPerson: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    memoryItem: { findMany: vi.fn() },
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
    isArchived: false, createdAt: new Date('2026-07-01'), updatedAt: new Date('2026-07-01'), ...o,
  }
}
// A labour memory row for job stats.
function labourItem(o?: object) {
  return {
    id: 'mem-1', jobId: JOB_ID, memoryType: 'LABOUR', summary: 'Kurt 6h',
    materialName: null, quantity: null, unit: null, labourHours: '6', labourPerson: 'Kurt', labourTask: 'fencing',
    labourPersonId: 'person-kurt', labourBudgetEnabled: true,
    costAmount: '20', costCurrency: 'GBP', costQualifier: 'per_hour', totalCostAmount: '120',
    unresolvedFlags: [], isRemoved: false, ...o,
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
  vi.mocked(prisma.labourPerson.findMany as any).mockResolvedValue([makePerson()])
  vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(null)
  vi.mocked(prisma.labourPerson.create as any).mockImplementation(async ({ data }: any) => ({ id: 'person-new', createdAt: new Date(), updatedAt: new Date(), ...data }))
  vi.mocked(prisma.labourPerson.update as any).mockImplementation(async ({ data }: any) => ({ ...makePerson(), ...data }))
  vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
})

const headers = { 'x-pilot-user-id': USER_ID, 'content-type': 'application/json' }
const URL = `/api/jobs/${JOB_ID}/labour-people`

describe('GET /api/jobs/:jobId/labour-people', () => {
  it('lists active people with per-job hours and budget cost', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([
      labourItem({ id: 'a', labourHours: '6', totalCostAmount: '120', labourBudgetEnabled: true }),
      labourItem({ id: 'b', labourHours: '4', totalCostAmount: null, costCurrency: null, labourBudgetEnabled: false }),
    ])
    const res = await app.inject({ method: 'GET', url: URL, headers })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ jobId: string; people: any[] }>()
    expect(body.jobId).toBe(JOB_ID)
    const kurt = body.people.find((p) => p.id === 'person-kurt')
    expect(kurt).toMatchObject({
      name: 'Kurt', defaultHourlyRateAmount: '20', defaultBudgetTreatment: 'counts_toward_budget',
      jobHours: '10', jobBudgetCostAmount: '120', hasEntriesWithoutRate: true,
    })
    // only budget-enabled trusted labour is counted as budget cost (120, not 120+null)
    expect(kurt.jobBudgetCostLabel).toBe('£120 budget cost')
  })

  it('returns people with no entries on this job (selectable for new entries)', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.labourPerson.findMany as any).mockResolvedValue([makePerson({ id: 'p-sam', name: 'Sam', normalizedName: 'sam' })])
    vi.mocked(prisma.memoryItem.findMany as any).mockResolvedValue([])
    const body = res_body(await app.inject({ method: 'GET', url: URL, headers }))
    expect(body.people).toHaveLength(1)
    expect(body.people[0]).toMatchObject({ id: 'p-sam', jobHours: null, jobBudgetCostAmount: null })
  })

  it('enforces ownership and auth', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.job.findUnique as any).mockResolvedValue(makeJob({ ownerUserId: 'other' }))
    expect((await app.inject({ method: 'GET', url: URL, headers })).statusCode).toBe(403)
    vi.mocked(prisma.user.findUnique as any).mockResolvedValue(null)
    expect((await app.inject({ method: 'GET', url: URL, headers: { 'x-pilot-user-id': 'ghost' } })).statusCode).toBe(401)
  })
})

describe('POST /api/jobs/:jobId/labour-people', () => {
  it('creates a person with a rate and budget treatment', async () => {
    const { prisma } = await import('../src/db/client.js')
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { name: '  Kurt ', defaultHourlyRateAmount: '20', defaultBudgetTreatment: 'counts_toward_budget' } })
    expect(res.statusCode).toBe(201)
    const data = vi.mocked(prisma.labourPerson.create as any).mock.calls[0][0].data
    expect(data).toMatchObject({ ownerUserId: USER_ID, name: 'Kurt', normalizedName: 'kurt', defaultHourlyRateAmount: '20', defaultHourlyRateCurrency: 'GBP', defaultBudgetTreatment: 'COUNTS_TOWARD_BUDGET' })
    expect(res.json<any>()).toMatchObject({ name: 'Kurt', defaultBudgetTreatment: 'counts_toward_budget' })
  })

  it('creates a person with no rate (hours_only)', async () => {
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Sam', defaultBudgetTreatment: 'hours_only' } })
    expect(res.statusCode).toBe(201)
    expect(res.json<any>()).toMatchObject({ defaultHourlyRateAmount: null, defaultHourlyRateCurrency: null, defaultBudgetTreatment: 'hours_only' })
  })

  it('rejects blank name, bad rate, non-GBP, and missing/invalid treatment', async () => {
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { defaultBudgetTreatment: 'hours_only' } })).statusCode).toBe(400) // missing name
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { name: '   ', defaultBudgetTreatment: 'hours_only' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Kurt', defaultHourlyRateAmount: '0', defaultBudgetTreatment: 'hours_only' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Kurt', defaultHourlyRateAmount: '20', defaultHourlyRateCurrency: 'EUR', defaultBudgetTreatment: 'hours_only' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Kurt' } })).statusCode).toBe(400) // missing treatment
    expect((await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Kurt', defaultBudgetTreatment: 'maybe' } })).statusCode).toBe(400)
  })

  it('rejects a duplicate active name with LABOUR_PERSON_ALREADY_EXISTS', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(makePerson())
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { name: 'Kurt', defaultBudgetTreatment: 'hours_only' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('LABOUR_PERSON_ALREADY_EXISTS')
  })
})

describe('PATCH /api/jobs/:jobId/labour-people/:personId', () => {
  const patchUrl = `${URL}/person-kurt`

  it('updates name, rate, and treatment; clears rate with null', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(makePerson())
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { defaultHourlyRateAmount: null, defaultBudgetTreatment: 'hours_only' } })
    expect(res.statusCode).toBe(200)
    const data = vi.mocked(prisma.labourPerson.update as any).mock.calls[0][0].data
    expect(data).toMatchObject({ defaultHourlyRateAmount: null, defaultHourlyRateCurrency: null, defaultBudgetTreatment: 'HOURS_ONLY' })
  })

  it('404s an unknown/cross-user person', async () => {
    const { prisma } = await import('../src/db/client.js')
    vi.mocked(prisma.labourPerson.findFirst as any).mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { name: 'X' } })
    expect(res.statusCode).toBe(404)
    expect(res.json<any>().code).toBe('LABOUR_PERSON_NOT_FOUND')
  })

  it('rejects a rename that collides with another active person', async () => {
    const { prisma } = await import('../src/db/client.js')
    // ownership lookup returns the target; the dup check finds a different active person
    vi.mocked(prisma.labourPerson.findFirst as any)
      .mockResolvedValueOnce(makePerson({ id: 'person-kurt', normalizedName: 'kurt' }))
      .mockResolvedValueOnce(makePerson({ id: 'person-other', normalizedName: 'sam' }))
    const res = await app.inject({ method: 'PATCH', url: patchUrl, headers, payload: { name: 'Sam' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<any>().code).toBe('LABOUR_PERSON_ALREADY_EXISTS')
  })
})

function res_body(res: { json: () => any }) { return res.json() }
