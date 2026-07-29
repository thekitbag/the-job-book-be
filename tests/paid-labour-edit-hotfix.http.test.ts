// Production-shaped real-DB regression coverage for paid Labour edits. It
// exercises the actual PATCH/Money/Budget workflow rather than a Prisma mock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'

const EMAIL_PREFIX = 'paid-labour-edit-hotfix-'
let app: FastifyInstance
let ownerId: string
let jobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((user) => user.id)
  if (!userIds.length) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((job) => job.id)
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.labourPerson.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

beforeAll(async () => {
  app = buildApp({ storage: new FakeAudioStorage(), transcription: new FakeTranscriptionProvider(), extraction: new FakeExtractionProvider() })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Owner', role: 'PILOT' } })).id
})
afterAll(async () => { await cleanup(); await app.close() })
beforeEach(async () => { jobId = (await prisma.job.create({ data: { ownerUserId: ownerId, title: 'Paid labour edit job', jobType: 'garden_room' } })).id })

const auth = () => ({ 'x-pilot-user-id': ownerId, 'content-type': 'application/json' })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth(), payload })
const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: auth(), payload })
const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-pilot-user-id': ownerId } })
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: { 'x-pilot-user-id': ownerId } })
const memoryUrl = () => `/api/jobs/${jobId}/memory-items`
const peopleUrl = () => `/api/jobs/${jobId}/labour-people`
const moneyUrl = () => `/api/jobs/${jobId}/money`

async function addPaidLabour(overrides: Record<string, unknown> = {}) {
  const result = await post(memoryUrl(), {
    memoryType: 'labour', summary: 'Kurt fitting cladding', labourPerson: 'Kurt', labourTask: 'fitting cladding',
    labourHours: '8', costAmount: '20', costCurrency: 'GBP', costQualifier: 'per_hour', markPaid: true, ...overrides,
  })
  expect(result.statusCode).toBe(201)
  expect(result.json().totalCostAmount).toBe('160')
  return result.json()
}

function fullForm(item: any, overrides: Record<string, unknown> = {}) {
  return {
    memoryType: 'labour', summary: item.summary, labourPerson: item.labourPerson, labourPersonId: item.labourPersonId,
    labourTask: item.labourTask, labourHours: item.labourHours, costAmount: item.costAmount,
    costCurrency: item.costCurrency, costQualifier: item.costQualifier, totalCostAmount: item.totalCostAmount,
    happenedAt: item.happenedAt, ...overrides,
  }
}

describe('paid labour PATCH cost guard', () => {
  it('allows non-cost/full-form edits for a paid production-shaped row with a job-local person', async () => {
    const kurt = await post(peopleUrl(), { name: 'Kurt', defaultHourlyRateAmount: '20', defaultHourlyRateCurrency: 'GBP' })
    const sam = await post(peopleUrl(), { name: 'Sam', defaultHourlyRateAmount: '30', defaultHourlyRateCurrency: 'GBP' })
    expect(kurt.statusCode).toBe(201)
    const item = await addPaidLabour({ labourPersonId: kurt.json().id, labourPerson: 'Kurt' })
    const saved = await patch(`${memoryUrl()}/${item.id}`, fullForm(item, {
      summary: 'Kurt completed cladding', labourTask: 'completed cladding', labourPerson: 'Sam', labourPersonId: sam.json().id,
      happenedAt: '2026-07-29',
    }))
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ labourPersonId: sam.json().id, labourPerson: 'Sam', labourTask: 'completed cladding', totalCostAmount: '160' })
    const money = (await get(moneyUrl())).json()
    expect(money.rows.filter((row: any) => row.sourceMemoryItemId === item.id)).toHaveLength(1)
  })

  it('allows non-cost edits for a paid production-shaped row with text-only labour person', async () => {
    const item = await addPaidLabour()
    expect(item.labourPersonId).toBeNull()
    const saved = await patch(`${memoryUrl()}/${item.id}`, fullForm(item, { labourTask: 'fitting final cladding', summary: 'Kurt finished cladding' }))
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ labourPerson: 'Kurt', labourPersonId: null, labourTask: 'fitting final cladding', totalCostAmount: '160' })
  })

  it('rejects a true paid-cost change until the explicit undo endpoint is used', async () => {
    const item = await addPaidLabour()
    const rejected = await patch(`${memoryUrl()}/${item.id}`, fullForm(item, { costAmount: '25', totalCostAmount: '200' }))
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: 'INVALID_FIELD', message: 'Undo paid before changing a labour cost amount' })
    let money = (await get(moneyUrl())).json()
    const event = money.rows.find((row: any) => row.sourceMemoryItemId === item.id)
    expect(event).toMatchObject({ kind: 'cost_paid', amount: '160' })
    expect((await del(`/api/jobs/${jobId}/money/events/${event.id}`)).statusCode).toBe(204)
    const saved = await patch(`${memoryUrl()}/${item.id}`, fullForm(item, { costAmount: '25', totalCostAmount: '200' }))
    expect(saved.statusCode).toBe(200)
    money = (await get(moneyUrl())).json()
    expect(money.rows.filter((row: any) => row.sourceMemoryItemId === item.id)).toHaveLength(0)
  })

  it('clears a blank/null rate on unpaid labour without losing hours', async () => {
    const blank = await addPaidLabour({ markPaid: false })
    const blankSaved = await patch(`${memoryUrl()}/${blank.id}`, fullForm(blank, { costAmount: '', costCurrency: 'GBP', costQualifier: 'per_hour', totalCostAmount: '160' }))
    expect(blankSaved.statusCode).toBe(200)
    expect(blankSaved.json()).toMatchObject({ labourHours: '8', costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null })
    const nullRate = await addPaidLabour({ markPaid: false })
    const nullSaved = await patch(`${memoryUrl()}/${nullRate.id}`, fullForm(nullRate, { costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null }))
    expect(nullSaved.statusCode).toBe(200)
    expect(nullSaved.json()).toMatchObject({ labourHours: '8', costAmount: null, totalCostAmount: null })
  })

  it('accepts £0 unpaid labour and keeps it out of Budget and Money eligibility', async () => {
    const item = await addPaidLabour({ markPaid: false })
    const saved = await patch(`${memoryUrl()}/${item.id}`, fullForm(item, { costAmount: '0', totalCostAmount: null }))
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ labourHours: '8', costAmount: '0', totalCostAmount: null })
    const budget = (await get(`/api/jobs/${jobId}/budget-summary`)).json()
    expect(budget.totals.knownSpendAmount).toBeNull()
    expect((await post(`/api/jobs/${jobId}/money/out`, { sourceMemoryItemId: item.id })).statusCode).toBe(400)
    expect((await get(moneyUrl())).json().moneyOutAmount).toBeNull()
  })
})
