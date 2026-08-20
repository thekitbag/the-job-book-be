// Supplier-account source costs must carry a trusted purchase date.
//
// The bug this pins: every source line inside a supplier payment receipt read
// "Date not recorded", because ordered materials were being stored with
// happenedAt = null on both creation paths. Every other screen hid it by
// falling back to source.capturedAt or createdAt at render time; the receipt
// deliberately does not fall back, so it was the first place the gap showed.
//
// The fix records the day at creation/confirmation time from first-hand
// evidence — the note's capture day for voice, today for a direct add — and
// changes nothing about the receipt. So these tests check the DATABASE column,
// not just the rendered label: a receipt that reads correctly because something
// guessed at render time would be the same bug wearing a different hat.
//
// They assert `sourceDate` (the ISO instant) rather than `sourceDateLabel`,
// because this file is about whether a date EXISTS. How that date is worded on
// a receipt line is a separate contract with its own tests.
//
// Real DB, HTTP level.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { runExtraction } from '../src/extraction/worker.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { ukLocalDayString } from '../src/lib/dates.js'

const EMAIL_PREFIX = 'source-cost-dates-'
const PAYMENTS_URL = '/api/book/money/supplier-payments'
const SUPPLIER = 'Sydenhams'

// The note was captured on a real day that is NOT today, so a test can tell a
// capture-day default apart from a today default apart from a render-time guess.
const NOTE_CAPTURED_AT = new Date('2026-07-07T09:00:00.000Z')
const NOTE_CAPTURE_DAY_NOON = '2026-07-07T11:00:00.000Z' // UK local noon, BST

let app: FastifyInstance
let ownerId: string
let jobId: string

const authHeaders = (userId: string) => ({ 'x-pilot-user-id': userId })
const jsonHeaders = (userId: string) => ({ ...authHeaders(userId), 'content-type': 'application/json' })

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const userIds = users.map((u) => u.id)
  if (!userIds.length) return
  await cleanupJobsOf(userIds)
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function cleanupJobsOf(userIds: string[]) {
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: userIds } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.supplierAccountPayment.deleteMany({ where: { ownerUserId: { in: userIds } } })
  if (!jobIds.length) return
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.queueItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
}

// ── Creation paths ────────────────────────────────────────────────────────────

// Path 1: direct manual add. The bought-item form sends no date.
async function directAdd(body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/memory-items`,
    headers: jsonHeaders(ownerId),
    payload: { memoryType: 'ordered_material', quantity: '10', unit: 'sheets', supplierName: SUPPLIER, costCurrency: 'GBP', costQualifier: 'total', ...body },
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json().id
}

// Path 2: voice capture. A real note and transcript, extracted by a stub
// provider that says nothing about a date — the production shape of "I got
// timber from Sydenhams" with no day spoken.
async function captureByVoice(facts: Array<Record<string, unknown>>) {
  const note = await prisma.rawNote.create({
    data: {
      jobId,
      clientNoteId: `note-${Math.random().toString(36).slice(2)}`,
      capturedAt: NOTE_CAPTURED_AT,
      mimeType: 'audio/webm',
      sizeBytes: 1024,
      serverStatus: 'TRANSCRIBED',
    },
  })
  const transcript = await prisma.transcript.create({
    data: { noteId: note.id, status: 'COMPLETED', text: 'Got timber from Sydenhams.', extractionStatus: null },
  })
  await runExtraction(transcript.id, {
    name: 'stub',
    model: 'stub-v1',
    async extractFacts() {
      return { facts: facts as never, schemaVersion: 'v1' }
    },
  } as never)
  return note.id
}

// Unit cost rather than a stated total, because extraction only derives a safe
// line total from `each` (materials) or `per_hour` (labour) — a settleable cost
// is the point of the fixture, not the arithmetic.
const boughtFact = (overrides: Record<string, unknown> = {}) => ({
  factType: 'ordered_material',
  summary: 'Bought timber from Sydenhams at £50 a sheet',
  materialName: 'Timber',
  quantity: '10',
  unit: 'sheets',
  supplierName: SUPPLIER,
  costAmount: '50',
  costCurrency: 'GBP',
  costQualifier: 'each',
  confidenceLabel: 'high',
  confidenceReason: 'stated',
  uncertaintyFlags: [],
  ...overrides,
})

async function reviewQueue() {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/review-queue`, headers: authHeaders(ownerId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

// The first draft queue item proposing a bought material.
async function boughtQueueItemId(): Promise<string> {
  const queue = await reviewQueue()
  const item = queue.sections
    .flatMap((s: { items: Array<{ id: string; proposedMemory?: { memoryType?: string } }> }) => s.items)
    .find((i: { proposedMemory?: { memoryType?: string } }) => i.proposedMemory?.memoryType === 'ordered_material')
  expect(item, `no ordered_material queue item in ${JSON.stringify(queue.sections.map((s: { key: string }) => s.key))}`).toBeDefined()
  return item.id
}

async function decide(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/jobs/${jobId}/review-queue-decisions`,
    headers: jsonHeaders(ownerId),
    payload: body,
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

const storedDate = async (memoryItemId: string) =>
  (await prisma.memoryItem.findUniqueOrThrow({ where: { id: memoryItemId } })).happenedAt

// ── Settlement helpers ────────────────────────────────────────────────────────

async function bookMoney() {
  const res = await app.inject({ method: 'GET', url: '/api/book/money', headers: authHeaders(ownerId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

let requestSeq = 0

async function settle(sourceMemoryItemIds: string[]) {
  const groupId = (await bookMoney()).toPayOnAccounts.supplierGroups.find(
    (g: { displayName: string }) => g.displayName === SUPPLIER,
  ).groupId
  const res = await app.inject({
    method: 'POST',
    url: PAYMENTS_URL,
    headers: jsonHeaders(ownerId),
    payload: {
      supplierGroupId: groupId,
      supplierName: SUPPLIER,
      sourceMemoryItemIds,
      clientRequestId: `scd-${Date.now()}-${requestSeq++}`,
      paidAt: '2026-08-10',
    },
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201)
  return res.json()
}

async function readReceipt(paymentId: string) {
  const res = await app.inject({ method: 'GET', url: `${PAYMENTS_URL}/${paymentId}`, headers: authHeaders(ownerId) })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return res.json()
}

interface SourceLine {
  sourceMemoryItemId: string
  amount: string
  sourceDate: string | null
}

function lineFor(receipt: { allocations: Array<{ sourceLines: SourceLine[] }> }, id: string): SourceLine {
  const line = receipt.allocations.flatMap((a) => a.sourceLines).find((l) => l.sourceMemoryItemId === id)
  expect(line, `no receipt line for ${id}`).toBeDefined()
  return line as SourceLine
}

const VOLATILE = new Set(['generatedAt'])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).map(([k, v]) => [k, stripVolatile(v)]),
    )
  }
  return value
}

async function financeSnapshot() {
  const out: Record<string, unknown> = {}
  for (const view of ['budget-summary', 'money']) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/${view}`, headers: authHeaders(ownerId) })
    expect(res.statusCode).toBe(200)
    out[view] = stripVolatile(res.json())
  }
  return out
}

function moneyShape(receipt: {
  totalAmount: string
  costCount: number
  paidAt: string
  allocations: Array<{ jobId: string; amount: string; sourceLines: SourceLine[] }>
}) {
  return {
    totalAmount: receipt.totalAmount,
    costCount: receipt.costCount,
    paidAt: receipt.paidAt,
    allocations: receipt.allocations.map((a) => ({
      jobId: a.jobId,
      amount: a.amount,
      lines: a.sourceLines.map((l) => [l.sourceMemoryItemId, l.amount]),
    })),
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED = 'true'
  app = buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  await cleanup()
  ownerId = (await prisma.user.create({ data: { email: `${EMAIL_PREFIX}owner@test.local`, name: 'Mike', role: 'PILOT' } })).id
})

afterAll(async () => {
  delete process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  delete process.env.PILOT_USER_ID
  process.env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED = 'true'
  await cleanupJobsOf([ownerId])
  jobId = (await prisma.job.create({
    data: { ownerUserId: ownerId, title: 'Mark fence', jobType: 'garden_room', status: 'STARTED' },
  })).id
})

// ── 1. Every creation path records a date ─────────────────────────────────────

describe('a new supplier-account cost is stored with a purchase date', () => {
  it('direct add with no date records today', async () => {
    const id = await directAdd({ materialName: 'Timber', costAmount: '500' })

    const happenedAt = await storedDate(id)
    expect(happenedAt).not.toBeNull()
    // Today in UK local terms — the day Mike is sitting there adding it.
    expect(ukLocalDayString(happenedAt as Date)).toBe(ukLocalDayString(new Date()))
  })

  it('direct add with an explicit date still records that date', async () => {
    const id = await directAdd({ materialName: 'Timber', costAmount: '500', happenedAt: '2026-06-02' })
    expect((await storedDate(id))?.toISOString()).toBe('2026-06-02T11:00:00.000Z')
  })

  it('voice capture records the day the note was captured, not the day it is processed', async () => {
    await captureByVoice([boughtFact()])

    const fact = await prisma.candidateFact.findFirstOrThrow({ where: { jobId, factType: 'ORDERED_MATERIAL' } })
    expect(fact.happenedAt?.toISOString()).toBe(NOTE_CAPTURE_DAY_NOON)
    expect(ukLocalDayString(fact.happenedAt as Date)).not.toBe(ukLocalDayString(new Date()))
  })

  it('review confirm carries the captured day onto the trusted memory', async () => {
    await captureByVoice([boughtFact()])
    const decision = await decide({ queueItemId: await boughtQueueItemId(), action: 'confirm' })

    expect((await storedDate(decision.memoryItemId))?.toISOString()).toBe(NOTE_CAPTURE_DAY_NOON)
  })

  it('review correct keeps the captured day when the correction is about something else', async () => {
    await captureByVoice([boughtFact()])
    const decision = await decide({
      queueItemId: await boughtQueueItemId(),
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Bought timber from Sydenhams for £480', materialName: 'Timber', quantity: '10', unit: 'sheets', supplierName: SUPPLIER, costAmount: '480', costCurrency: 'GBP', costQualifier: 'total' },
    })

    expect((await storedDate(decision.memoryItemId))?.toISOString()).toBe(NOTE_CAPTURE_DAY_NOON)
  })

  it('review correct honours an explicitly corrected date', async () => {
    await captureByVoice([boughtFact()])
    const decision = await decide({
      queueItemId: await boughtQueueItemId(),
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Bought timber', materialName: 'Timber', supplierName: SUPPLIER, costAmount: '500', costCurrency: 'GBP', costQualifier: 'total', happenedAt: '2026-07-02T11:00:00.000Z' },
    })

    expect((await storedDate(decision.memoryItemId))?.toISOString()).toBe('2026-07-02T11:00:00.000Z')
  })

  it('review correct honours an explicit "I do not know when"', async () => {
    await captureByVoice([boughtFact()])
    const decision = await decide({
      queueItemId: await boughtQueueItemId(),
      action: 'correct',
      corrected: { memoryType: 'ordered_material', summary: 'Bought timber', materialName: 'Timber', supplierName: SUPPLIER, costAmount: '500', costCurrency: 'GBP', costQualifier: 'total', happenedAt: null },
    })

    // A deliberate null is a real answer and is not overwritten by a default.
    expect(await storedDate(decision.memoryItemId)).toBeNull()
  })

  it('does not start dating types whose date is not evidence', async () => {
    await captureByVoice([{
      factType: 'used_material', summary: 'Used 6 OSB boards', materialName: 'OSB', quantity: '6', unit: 'boards',
      confidenceLabel: 'high', confidenceReason: 'stated', uncertaintyFlags: [],
    }])
    const fact = await prisma.candidateFact.findFirstOrThrow({ where: { jobId, factType: 'USED_MATERIAL' } })
    expect(fact.happenedAt).toBeNull()

    const res = await app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/memory-items`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'general_note', summary: 'Gate is sticking' },
    })
    expect(res.statusCode).toBe(201)
    expect(await storedDate(res.json().id)).toBeNull()
  })
})

// ── 2. The receipt shows it ───────────────────────────────────────────────────

describe('settling a newly recorded cost shows its date on the receipt', () => {
  it('dates a directly added cost on the receipt line', async () => {
    const id = await directAdd({ materialName: 'Timber', costAmount: '500' })
    const receipt = await settle([id])

    const line = lineFor(receipt, id)
    expect(line.sourceDate).not.toBeNull()
    expect(ukLocalDayString(new Date(line.sourceDate as string))).toBe(ukLocalDayString(new Date()))
  })

  it('dates a voice-captured, confirmed cost with the capture day', async () => {
    await captureByVoice([boughtFact()])
    const decision = await decide({ queueItemId: await boughtQueueItemId(), action: 'confirm' })
    const receipt = await settle([decision.memoryItemId])

    expect(lineFor(receipt, decision.memoryItemId).sourceDate).toBe(NOTE_CAPTURE_DAY_NOON)
  })

  it('tells two bought materials apart by their own dates', async () => {
    const older = await directAdd({ materialName: 'Timber', costAmount: '500', happenedAt: '2026-07-07' })
    const newer = await directAdd({ materialName: 'Timber', costAmount: '300', happenedAt: '2026-07-09' })
    const receipt = await settle([older, newer])

    expect(lineFor(receipt, older).sourceDate).toBe('2026-07-07T11:00:00.000Z')
    expect(lineFor(receipt, newer).sourceDate).toBe('2026-07-09T11:00:00.000Z')
  })
})

// ── 3. Correcting the source date ─────────────────────────────────────────────

describe('correcting the source date', () => {
  it('updates the receipt line on the next read', async () => {
    const id = await directAdd({ materialName: 'Timber', costAmount: '500', happenedAt: '2026-07-07' })
    const receipt = await settle([id])
    expect(lineFor(receipt, id).sourceDate).toBe('2026-07-07T11:00:00.000Z')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/memory-items/${id}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', happenedAt: '2026-07-02' },
    })
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200)

    expect(lineFor(await readReceipt(receipt.id), id).sourceDate).toBe('2026-07-02T11:00:00.000Z')
  })
})

// ── 4. Genuinely undated costs still say so ───────────────────────────────────

describe('a cost with no trusted date', () => {
  // The only ways an ordered material is dateless now: an explicit clear, or a
  // row written before this fix. Neither may be papered over at render time.
  it('says Date not recorded after the date is explicitly cleared', async () => {
    const id = await directAdd({ materialName: 'Timber', costAmount: '500' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}/memory-items/${id}`,
      headers: jsonHeaders(ownerId),
      payload: { memoryType: 'ordered_material', happenedAt: null },
    })
    expect(res.statusCode).toBe(200)
    expect(await storedDate(id)).toBeNull()

    const receipt = await settle([id])
    expect(lineFor(receipt, id).sourceDate).toBeNull()
  })

  it('leaves an older dateless row dateless — no backfill from createdAt or today', async () => {
    // A row as it exists in the database today, written before the fix.
    const id = await directAdd({ materialName: 'Legacy timber', costAmount: '250', happenedAt: '2026-07-07' })
    await prisma.memoryItem.update({ where: { id }, data: { happenedAt: null } })

    const receipt = await settle([id])
    expect(lineFor(receipt, id).sourceDate).toBeNull()
    // Reading the receipt did not quietly write a date onto the old row.
    expect(await storedDate(id)).toBeNull()
  })
})

// ── 5. Nothing about the money moved ──────────────────────────────────────────

describe('the money is untouched by any of this', () => {
  it('leaves Budget, Money, allocations, paid state and Undo exactly as before', async () => {
    const dated = await directAdd({ materialName: 'Timber', costAmount: '500' })
    const undated = await directAdd({ materialName: 'Fixings', costAmount: '45' })
    await prisma.memoryItem.update({ where: { id: undated }, data: { happenedAt: null } })

    const receipt = await settle([dated, undated])
    expect(receipt.totalAmount).toBe('545')
    const before = { money: moneyShape(receipt), finance: await financeSnapshot() }

    // Correct one date, and give the undated line one.
    for (const [id, happenedAt] of [[dated, '2026-07-02'], [undated, '2026-07-15']] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/jobs/${jobId}/memory-items/${id}`,
        headers: jsonHeaders(ownerId),
        payload: { memoryType: 'ordered_material', happenedAt },
      })
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
    }

    const after = await readReceipt(receipt.id)
    expect(lineFor(after, dated).sourceDate).toBe('2026-07-02T11:00:00.000Z')
    expect(lineFor(after, undated).sourceDate).toBe('2026-07-15T11:00:00.000Z')
    // Amount, cost count, payment date and per-job allocation all identical.
    expect(moneyShape(after)).toEqual(before.money)
    expect(await financeSnapshot()).toEqual(before.finance)

    // Paid state held: neither cost is back on the unpaid account list.
    const account = (await bookMoney()).toPayOnAccounts
    const unpaid = account?.supplierGroups.flatMap((g: { lines: SourceLine[] }) => g.lines) ?? []
    expect(unpaid.map((l: SourceLine) => l.sourceMemoryItemId)).not.toContain(dated)

    // And the aggregate Undo still returns both costs.
    const undo = await app.inject({ method: 'DELETE', url: `${PAYMENTS_URL}/${receipt.id}`, headers: authHeaders(ownerId) })
    expect(undo.statusCode, JSON.stringify(undo.json())).toBe(200)
    expect(undo.json().isDeleted).toBe(true)
    const backOnAccount = (await bookMoney()).toPayOnAccounts.supplierGroups
      .flatMap((g: { lines: SourceLine[] }) => g.lines)
      .map((l: SourceLine) => l.sourceMemoryItemId)
    expect(backOnAccount).toContain(dated)
    expect(backOnAccount).toContain(undated)
  })
})
