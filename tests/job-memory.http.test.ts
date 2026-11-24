import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { FakeAudioStorage } from './fakes/storage.js'
import { FakeTranscriptionProvider } from '../src/transcription/fake.js'
import { FakeExtractionProvider } from '../src/extraction/fake.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prisma } from '../src/db/client.js'
import { exportMoney } from '../src/services/money-export.js'
import { runExtraction } from '../src/extraction/worker.js'
import { isMoneyFeaturesEnabled } from '../src/config/features.js'

let app: FastifyInstance
const storage = new FakeAudioStorage()
let owner: string
let outsider: string
let admin: string
let job: string
let category: string
let person: string
let bought: string
let leftover: string
let note: string
let transcript: string
const headers = () => ({ 'x-pilot-user-id': owner })
const base = () => `/api/jobs/${job}`
const moneyFields = [
  'costAmount',
  'costCurrency',
  'costQualifier',
  'totalCostAmount',
  'refundAmount',
  'refundCurrency',
  'budgetCategoryId',
  'labourPersonId',
  'labourBudgetEnabled',
] as const
const storedMoney = async (id: string) => {
  const m = await prisma.memoryItem.findUniqueOrThrow({ where: { id } })
  return Object.fromEntries(moneyFields.map((k) => [k, m[k]]))
}
// Independent of the production projector: a regression in its predicate cannot
// accidentally make this scan pass too.
function scan(value: unknown) {
  if (typeof value === 'string') expect(value).not.toContain('£')
  if (!value || typeof value !== 'object') return
  for (const [key, v] of Object.entries(value)) {
    expect(key).not.toMatch(
      /cost|refund|spend|lineTotal|budget|paid|markPaid|customerTotal|moneyEvent|exclu|labourPeople|labourPersonId|inheritedLabourPerson/i,
    )
    scan(v)
  }
}
async function manual(type: string, more: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `${base()}/memory-items?cached-client=true`,
    headers: headers(),
    payload: {
      memoryType: type,
      materialName: 'OSB 18mm',
      quantity: 'about half a pallet',
      ...more,
    },
  })
  expect(res.statusCode, res.body).toBe(201)
  scan(res.json())
  return res.json()
}
async function item(
  type:
    | 'LABOUR'
    | 'ORDERED_MATERIAL'
    | 'LEFTOVER_MATERIAL'
    | 'BUDGET_COST'
    | 'GENERAL_NOTE'
    | 'RETURNED_MATERIAL',
  more: Record<string, unknown> = {},
) {
  const decision = await prisma.reviewDecision.create({
    data: { jobId: job, decidedBy: owner, action: 'ADD_MISSING' },
  })
  return prisma.memoryItem.create({
    data: {
      jobId: job,
      reviewDecisionId: decision.id,
      memoryType: type,
      summary: 'Historical £240 cost',
      isManual: true,
      ...more,
    } as never,
  })
}
async function fact(
  type:
    | 'ORDERED_MATERIAL'
    | 'LABOUR'
    | 'BUDGET_COST'
    | 'CUSTOMER_CHANGE'
    | 'WATCH_OUT'
    | 'SUPPLIER_DELIVERY_NOTE',
  more: Record<string, unknown> = {},
) {
  return prisma.candidateFact.create({
    data: {
      jobId: job,
      sourceNoteId: note,
      sourceTranscriptId: transcript,
      factType: type,
      summary: 'Model said £240',
      confidenceLabel: 'HIGH',
      confidenceReason: 'Explicit',
      uncertaintyFlags: [],
      ...more,
    } as never,
  })
}
async function cleanup() {
  if (!owner) return
  await prisma.supportAuditEvent.deleteMany({ where: { adminUserId: admin } })
  await prisma.workshopItem.deleteMany({ where: { ownerUserId: owner } })
  await prisma.jobPhoto.deleteMany({ where: { jobId: job } })
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId: job } })
  await prisma.supplierAccountPayment.deleteMany({
    where: { ownerUserId: owner },
  })
  await prisma.memoryItem.deleteMany({ where: { jobId: job } })
  await prisma.queueItem.deleteMany({ where: { jobId: job } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: job } })
  await prisma.candidateFact.deleteMany({ where: { jobId: job } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: job } } })
  await prisma.rawNote.deleteMany({ where: { jobId: job } })
  await prisma.jobPayment.deleteMany({ where: { jobId: job } })
  await prisma.labourPerson.deleteMany({ where: { jobId: job } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId: job } })
  await prisma.job.deleteMany({ where: { id: job } })
  await prisma.user.deleteMany({
    where: { id: { in: [owner, outsider, admin] } },
  })
}
beforeAll(async () => {
  delete process.env.PILOT_USER_ID
  process.env.LOG_LEVEL = 'silent'
  app = buildApp({
    storage,
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
  await app.ready()
  const token = randomUUID()
  owner = (
    await prisma.user.create({
      data: { email: `memory-owner-${token}@test.local`, name: 'Mike' },
    })
  ).id
  outsider = (
    await prisma.user.create({
      data: { email: `memory-other-${token}@test.local`, name: 'Other' },
    })
  ).id
  admin = (
    await prisma.user.create({
      data: {
        email: `memory-admin-${token}@test.local`,
        name: 'Founder',
        role: 'INTERNAL',
      },
    })
  ).id
  job = (
    await prisma.job.create({
      data: {
        ownerUserId: owner,
        title: 'Memory fixture',
        jobType: 'garden_room',
        customerTotalAmount: '9000',
        customerTotalCurrency: 'GBP',
      },
    })
  ).id
  category = (
    await prisma.jobBudgetCategory.create({
      data: {
        jobId: job,
        name: 'Materials',
        budgetAmount: '500',
        budgetCurrency: 'GBP',
      },
    })
  ).id
  person = (
    await prisma.labourPerson.create({
      data: {
        jobId: job,
        name: 'Kurt',
        normalizedName: 'kurt',
        defaultHourlyRateAmount: '35',
      },
    })
  ).id
  bought = (
    await item('ORDERED_MATERIAL', {
      materialName: 'OSB',
      quantity: '10',
      unit: 'sheets',
      costAmount: '24',
      costCurrency: 'GBP',
      costQualifier: 'each',
      totalCostAmount: '240',
      budgetCategoryId: category,
    })
  ).id
  leftover = (
    await item('LEFTOVER_MATERIAL', {
      materialName: 'OSB',
      quantity: '10',
      unit: 'sheets',
      costAmount: '24',
      costCurrency: 'GBP',
      totalCostAmount: '240',
    })
  ).id
  await item('RETURNED_MATERIAL', {
    materialName: 'OSB',
    quantity: '1',
    unit: 'sheet',
    refundAmount: '24',
    refundCurrency: 'GBP',
  })
  await item('BUDGET_COST', {
    costAmount: '200',
    totalCostAmount: '200',
    costCurrency: 'GBP',
  })
  await item('LABOUR', {
    labourPersonId: person,
    labourPerson: 'wrong name',
    labourHours: '6',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
    costAmount: '35',
    costCurrency: 'GBP',
    totalCostAmount: '210',
    labourBudgetEnabled: true,
  })
  await item('LABOUR', {
    labourPerson: 'kurt',
    labourHours: '4',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
  })
  await item('LABOUR', {
    labourPerson: 'Kurt',
    labourHours: '2',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
  })
  await item('LABOUR', {
    labourPerson: 'me',
    labourHours: '7',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
  })
  await item('LABOUR', {
    labourPerson: null,
    labourHours: '1.5',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
  })
  await item('LABOUR', {
    labourPerson: 'I',
    labourHours: '0.5',
    happenedAt: new Date('2026-07-08T11:00:00Z'),
  })
  await item('LABOUR', {
    labourPerson: 'cost only',
    costAmount: '600',
    costCurrency: 'GBP',
    totalCostAmount: '600',
  })
  await prisma.jobPayment.create({
    data: { jobId: job, amount: '3000', paidAt: new Date('2026-07-08') },
  })
  const supplierPayment = await prisma.supplierAccountPayment.create({
    data: {
      ownerUserId: owner,
      supplierName: 'Jewson',
      amount: '240',
      paidAt: new Date('2026-07-08'),
      clientRequestId: randomUUID(),
    },
  })
  await prisma.jobMoneyEvent.create({
    data: {
      supplierAccountPaymentId: supplierPayment.id,
      jobId: job,
      kind: 'COST_PAID',
      direction: 'OUT',
      sourceMemoryItemId: bought,
      amount: '240',
      currency: 'GBP',
      occurredAt: new Date('2026-07-08'),
    },
  })
  note = (
    await prisma.rawNote.create({
      data: {
        jobId: job, ownerUserId: owner, filedAt: new Date(),
        clientNoteId: randomUUID(),
        capturedAt: new Date('2026-07-08T09:00:00Z'),
        mimeType: 'audio/webm',
        sizeBytes: 20,
        durationMs: 11000,
        serverStatus: 'EXTRACTED',
      },
    })
  ).id
  transcript = (
    await prisma.transcript.create({
      data: {
        noteId: note,
        status: 'COMPLETED',
        revision: 1,
        text: 'Bought ten sheets OSB, £240 from Jewson.',
      },
    })
  ).id
})
beforeEach(() => {
  delete process.env.MONEY_FEATURES_ENABLED
})
afterAll(async () => {
  await cleanup()
  await app.close()
  process.env.MONEY_FEATURES_ENABLED = 'true'
})

describe('job memory strip-back: real database and HTTP contract', () => {
  it('fails closed for absent, empty and misspelled flags', () => {
    for (const value of [undefined, '', 'false', 'treu', '0'])
      expect(isMoneyFeaturesEnabled({ MONEY_FEATURES_ENABLED: value })).toBe(
        false,
      )
    for (const value of ['true', '1', ' yes ', 'ON'])
      expect(isMoneyFeaturesEnabled({ MONEY_FEATURES_ENABLED: value })).toBe(
        true,
      )
  })
  it('scans all builder read models; gate-on restores the exact read models', async () => {
    const paths = [
      '/api/jobs',
      '/api/jobs/current',
      base(),
      `${base()}/details`,
      `${base()}/memory-view`,
      `${base()}/review-queue`,
      '/api/workshop',
    ]
    const stable = (body: string) =>
      JSON.parse(body, (k, v) => (k === 'generatedAt' ? undefined : v))
    const snapshots = []
    // Optional compatibility run against an archived pre-change application.
    const baseline = process.env.JOB_MEMORY_BASELINE_APP
      ? ((
          await import(process.env.JOB_MEMORY_BASELINE_APP)
        ).buildApp() as FastifyInstance)
      : null
    if (baseline) await baseline.ready()
    process.env.MONEY_FEATURES_ENABLED = 'true'
    for (const url of paths) {
      const res = await app.inject({ url, headers: headers() })
      expect(res.statusCode, res.body).toBe(200)
      snapshots.push(stable(res.body))
    }
    if (baseline) {
      for (let i = 0; i < paths.length; i++) {
        const res = await baseline.inject({ url: paths[i], headers: headers() })
        expect(res.statusCode, res.body).toBe(200)
        expect(stable(res.body)).toEqual(snapshots[i])
      }
      await baseline.close()
    }
    delete process.env.MONEY_FEATURES_ENABLED
    for (const url of paths) {
      const res = await app.inject({ url, headers: headers() })
      expect(res.statusCode, res.body).toBe(200)
      scan(res.json())
    }
    process.env.MONEY_FEATURES_ENABLED = 'true'
    for (let i = 0; i < paths.length; i++)
      expect(
        stable((await app.inject({ url: paths[i], headers: headers() })).body),
      ).toEqual(snapshots[i])
  })
  it('gates every registered method in each money group and keeps support money reads', async () => {
    // Fastify route registration is the inventory; coverage includes future methods
    // added to a gated group. This also proves unknown bodies never reach parsing.
    const routes = app.printRoutes({ commonPrefix: false })
    expect(routes).toContain('budget-summary')
    const paths = [
      'budget-summary',
      'budget-categories',
      `budget-categories/${category}`,
      'money',
      'money/out',
      'money/events',
      `money/events/${bought}`,
      'payments',
      'payments/customer-total',
      `payments/${bought}`,
      'labour-people',
      `labour-people/${person}`,
      'receipts',
      `receipts/${bought}`,
    ]
    for (const path of paths)
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        if (path.startsWith('receipts') && method === 'GET') continue
        const res = await app.inject({
          method,
          url: `${base()}/${path}`,
          headers: headers(),
        })
        expect(res.statusCode, `${method} ${path}: ${res.body}`).toBe(404)
        expect(res.json().code).toBe('FEATURE_DISABLED')
      }
    for (const path of [
      '',
      '/supplier-payments',
      `/supplier-payments/${bought}`,
      '/suppliers/Jewson',
    ])
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: `/api/book/money${path}`,
          headers: headers(),
        })
        expect(res.statusCode).toBe(404)
        expect(res.json().code).toBe('FEATURE_DISABLED')
      }
    for (const path of [
      'budget-summary',
      'money',
      'payments',
      'labour-people',
      'memory-view',
      'review-queue',
    ]) {
      const res = await app.inject({
        url: `/api/internal/support/jobs/${job}/${path}`,
        headers: { 'x-pilot-user-id': admin },
      })
      expect(res.statusCode, res.body).toBe(200)
      if (path === 'memory-view')
        expect(res.json().costSummary.orderedMaterials.knownSpendAmount).toBe(
          '240',
        )
    }
  })
  it('adds materials in all three states using only the four fields and enforces limits', async () => {
    for (const state of [
      'ordered_material',
      'used_material',
      'leftover_material',
    ]) {
      const result = await manual(state, {
        supplierName: 'Jewson',
        locationOrUse: 'for coving',
        happenedAt: '1999-01-01',
        costAmount: { bad: true },
        totalCostAmount: 'garbage',
        markPaid: 'invalid',
        budgetCategoryId: false,
      })
      const saved = await prisma.memoryItem.findUniqueOrThrow({
        where: { id: result.id },
      })
      expect(saved.quantity).toBe('about half a pallet')
      expect(saved.unit).toBeNull()
      expect(saved.summary).toBe(
        'OSB 18mm, about half a pallet, Jewson, for coving',
      )
      expect(saved.costAmount).toBeNull()
      expect(saved.totalCostAmount).toBeNull()
      expect(saved.budgetCategoryId).toBeNull()
      expect(saved.happenedAt?.toISOString().slice(0, 10)).not.toBe(
        '1999-01-01',
      )
    }
    for (const [key, len] of [
      ['materialName', 121],
      ['quantity', 61],
      ['supplierName', 81],
      ['locationOrUse', 201],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `${base()}/memory-items`,
        headers: headers(),
        payload: {
          memoryType: 'ordered_material',
          materialName: 'OSB',
          quantity: '1',
          [key]: 'x'.repeat(len),
        },
      })
      expect(res.statusCode).toBe(400)
    }
    for (const key of ['materialName', 'quantity']) {
      const res = await app.inject({
        method: 'POST',
        url: `${base()}/memory-items`,
        headers: headers(),
        payload: {
          memoryType: 'used_material',
          materialName: 'OSB',
          quantity: '1',
          [key]: null,
        },
      })
      expect(res.statusCode).toBe(400)
    }
  })
  it('edits a paid legacy material without changing any money column or quantity/unit when amount is unchanged', async () => {
    const before = await storedMoney(bought)
    const count = await prisma.jobMoneyEvent.count({ where: { jobId: job } })
    for (const patch of [
      { materialName: 'OSB 18mm' },
      {
        quantity: '10 sheets',
        supplierName: 'Selco',
        costAmount: 'invalid',
        budgetCategoryId: false,
      },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `${base()}/memory-items/${bought}`,
        headers: headers(),
        payload: patch,
      })
      expect(res.statusCode, res.body).toBe(200)
      scan(res.json())
      expect(await storedMoney(bought)).toEqual(before)
      const saved = await prisma.memoryItem.findUniqueOrThrow({
        where: { id: bought },
      })
      expect(saved.quantity).toBe('10')
      expect(saved.unit).toBe('sheets')
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/memory-items/${bought}`,
      headers: headers(),
      payload: { quantity: 'about half a pallet' },
    })
    expect(res.statusCode, res.body).toBe(200)
    const saved = await prisma.memoryItem.findUniqueOrThrow({
      where: { id: bought },
    })
    expect(saved.unit).toBeNull()
    expect(saved.quantity).toBe('about half a pallet')
    expect(await storedMoney(bought)).toEqual(before)
    expect(await prisma.jobMoneyEvent.count({ where: { jobId: job } })).toBe(
      count,
    )
  })
  it('ignores refunds on return and preserves source money', async () => {
    const before = await storedMoney(leftover)
    const count = await prisma.jobMoneyEvent.count({ where: { jobId: job } })
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/memory-items/${leftover}/return`,
      headers: headers(),
      payload: {
        quantity: '2',
        refundAmount: 'garbage',
        refundCurrency: 'EUR',
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    scan(res.json())
    expect(await storedMoney(leftover)).toEqual(before)
    const saved = await prisma.memoryItem.findUniqueOrThrow({
      where: { id: res.json().returnedItem.id },
    })
    expect(saved.refundAmount).toBeNull()
    expect(await prisma.jobMoneyEvent.count({ where: { jobId: job } })).toBe(
      count,
    )
  })
  it('computes exact hours, resolves names consistently and hides cost-only labour', async () => {
    const res = await app.inject({
      url: `${base()}/memory-view`,
      headers: headers(),
    })
    expect(res.statusCode, res.body).toBe(200)
    const h = res.json().hours
    expect(h.totalHours).toBe('21')
    expect(h.people).toEqual([
      { name: 'Kurt', hours: '12' },
      { name: 'Mike', hours: '9' },
    ])
    expect(h.days[0].totalHours).toBe('21')
    expect(
      h.days[0].entries.map((e: { person: string }) => e.person).sort(),
    ).toEqual(['Kurt', 'Kurt', 'Kurt', 'Mike', 'Mike', 'Mike'])
    const added = await manual('labour', {
      labourPerson: 'Alice',
      labourHours: '3.25',
      happenedAt: '2026-07-07',
      labourPersonId: person,
      costAmount: '35',
      markPaid: true,
    })
    expect((await storedMoney(added.id)).labourPersonId).toBeNull()
    expect((await storedMoney(added.id)).costAmount).toBeNull()
  })
  it('validates manual hours: person, hours bounds and calendar date', async () => {
    for (const patch of [
      { labourPerson: null },
      { labourPerson: ' ' },
      { labourPerson: 'x'.repeat(61) },
      { labourHours: null },
      { labourHours: '0' },
      { labourHours: '24.01' },
      { labourHours: 'about 6' },
      { happenedAt: '2999-01-01' },
      { happenedAt: '2026-02-30' },
      { happenedAt: '2026-07-07T10:00:00Z' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `${base()}/memory-items`,
        headers: headers(),
        payload: {
          memoryType: 'labour',
          labourPerson: 'Kurt',
          labourHours: '6',
          happenedAt: '2026-07-07',
          ...patch,
        },
      })
      expect(res.statusCode, res.body).toBe(400)
      expect(['MISSING_FIELD', 'INVALID_FIELD']).toContain(res.json().code)
    }
  })
  it('excludes money/note facts without changing DRAFT or deleting queue rows; confirms mixed facts without money links', async () => {
    const excluded = await Promise.all([
      fact('BUDGET_COST', { costAmount: '250' }),
      fact('LABOUR', { costAmount: '600' }),
      fact('CUSTOMER_CHANGE'),
      fact('WATCH_OUT'),
      fact('SUPPLIER_DELIVERY_NOTE'),
    ])
    const mixed = await fact('ORDERED_MATERIAL', {
      materialName: 'insulation',
      quantity: '3',
      unit: 'packs',
      supplierName: 'Jewson',
      costAmount: '80',
      costCurrency: 'GBP',
      totalCostAmount: '240',
    })
    process.env.MONEY_FEATURES_ENABLED = 'true'
    const oldQueue = (
      await app.inject({ url: `${base()}/review-queue`, headers: headers() })
    ).json()
    const excludedIds: string[] = oldQueue.sections
      .flatMap((s: any) => s.items)
      .filter((i: any) =>
        i.sourceCandidateFactIds.some((id: string) =>
          excluded.some((f) => f.id === id),
        ),
      )
      .map((i: any) => i.id)
    for (const id of excludedIds)
      await prisma.queueItem.create({
        data: {
          id,
          jobId: job,
          sectionKey: 'budget_costs',
          kind: 'SINGLE',
          reviewLabel: 'Old money',
          summary: '£250',
          proposedMemory: {},
          confidenceLabel: 'high',
          sourceCandidateFactIds: [],
        },
      })
    delete process.env.MONEY_FEATURES_ENABLED
    const res = await app.inject({
      url: `${base()}/review-queue`,
      headers: headers(),
    })
    scan(res.json())
    const checks = res.json().sections.flatMap((s: any) => s.items)
    expect(checks).toHaveLength(1)
    expect(checks[0].summary).toBe('insulation, 3 packs, Jewson')
    expect(checks[0].reviewLabel).toBe(checks[0].summary)
    const confirm = await app.inject({
      method: 'POST',
      url: `${base()}/review-queue-decisions`,
      headers: headers(),
      payload: {
        action: 'confirm',
        queueItemId: checks[0].id,
        budgetCategoryId: category,
        labourPersonId: person,
      },
    })
    expect(confirm.statusCode, confirm.body).toBe(200)
    const saved = await storedMoney(confirm.json().memoryItemId)
    expect(saved.costAmount).toBeNull()
    expect(saved.budgetCategoryId).toBeNull()
    expect(saved.labourPersonId).toBeNull()
    expect(
      (
        await prisma.candidateFact.findUniqueOrThrow({
          where: { id: mixed.id },
        })
      ).costAmount,
    ).toBe('80')
    expect(
      await prisma.candidateFact.count({
        where: { id: { in: excluded.map((f) => f.id) }, status: 'DRAFT' },
      }),
    ).toBe(excluded.length)
    expect(
      await prisma.queueItem.count({ where: { id: { in: excludedIds } } }),
    ).toBe(excludedIds.length)
    const stale = await app.inject({
      method: 'POST',
      url: `${base()}/review-queue-decisions`,
      headers: headers(),
      payload: { action: 'dismiss', queueItemId: excludedIds[0] },
    })
    expect(stale.statusCode).toBe(404)
  })
  it('lists pending, failed, latest completed, typed notes and photos/receipts once, with ownership checks', async () => {
    const pending = await prisma.rawNote.create({
      data: {
        jobId: job, ownerUserId: owner, filedAt: new Date(),
        clientNoteId: randomUUID(),
        capturedAt: new Date('2026-07-09'),
        mimeType: 'audio/webm',
        sizeBytes: 1,
      },
    })
    const failed = await prisma.rawNote.create({
      data: {
        jobId: job, ownerUserId: owner, filedAt: new Date(),
        clientNoteId: randomUUID(),
        capturedAt: new Date('2026-07-10'),
        mimeType: 'audio/webm',
        sizeBytes: 1,
        serverStatus: 'FAILED',
      },
    })
    await prisma.transcript.create({
      data: { noteId: failed.id, status: 'FAILED' },
    })
    await prisma.transcript.create({
      data: {
        noteId: note,
        revision: 2,
        status: 'COMPLETED',
        text: 'Latest words, £240.',
      },
    })
    await item('GENERAL_NOTE', { summary: 'Typed note, £250' })
    const derived = await fact('WATCH_OUT')
    await item('GENERAL_NOTE', {
      sourceCandidateFactId: derived.id,
      isManual: false,
      summary: 'Already in the voice note',
    })
    const photo = await prisma.jobPhoto.create({
      data: {
        jobId: job,
        uploadedByUserId: owner,
        storageKey: randomUUID(),
        bucket: 'fake',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        linkedNoteId: note,
      },
    })
    const receipt = await prisma.jobPhoto.create({
      data: {
        jobId: job,
        uploadedByUserId: owner,
        storageKey: randomUUID(),
        bucket: 'fake',
        mimeType: 'application/pdf',
        fileKind: 'PDF',
        kind: 'RECEIPT',
        sizeBytes: 1,
      },
    })
    await storage.store(
      receipt.storageKey,
      Buffer.from('%PDF-1.4 legacy receipt'),
      'application/pdf',
    )
    const receiptFile = await app.inject({
      url: `${base()}/receipts/${receipt.id}/file`,
      headers: headers(),
    })
    expect(receiptFile.statusCode, receiptFile.body).toBe(200)
    expect(receiptFile.headers['content-type']).toContain('application/pdf')
    const res = await app.inject({ url: `${base()}/log`, headers: headers() })
    expect(res.statusCode, res.body).toBe(200)
    const entries = res.json().entries
    expect(entries.find((e: any) => e.noteId === pending.id)).toMatchObject({
      transcriptStatus: 'pending',
      text: null,
    })
    expect(entries.find((e: any) => e.noteId === failed.id)).toMatchObject({
      transcriptStatus: 'failed',
      text: null,
    })
    expect(entries.find((e: any) => e.noteId === note)).toMatchObject({
      transcriptStatus: 'completed',
      text: 'Latest words, £240.',
      linkedPhotoIds: [photo.id],
    })
    expect(entries.filter((e: any) => e.kind === 'typed_note')).toHaveLength(1)
    expect(entries.find((e: any) => e.id === receipt.id)).toMatchObject({
      kind: 'photo',
      fileKind: 'PDF',
      fileUrl: `${base()}/receipts/${receipt.id}/file`,
    })
    expect(
      (
        await app.inject({
          url: `${base()}/log`,
          headers: { 'x-pilot-user-id': outsider },
        })
      ).statusCode,
    ).toBe(404)
    expect((await app.inject({ url: `${base()}/log` })).statusCode).toBe(401)
  })
  it('exports CSV counts equal to database counts with no writes', async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          prisma.memoryItem.findMany({
            where: { jobId: job },
            orderBy: { id: 'asc' },
          }),
          prisma.jobMoneyEvent.findMany({
            where: { jobId: job },
            orderBy: { id: 'asc' },
          }),
          prisma.jobBudgetCategory.findMany({ where: { jobId: job } }),
          prisma.jobPayment.findMany({ where: { jobId: job } }),
        ]),
      )
    const before = await snapshot()
    const dir = await mkdtemp(join(tmpdir(), 'memory-export-'))
    try {
      const counts = await exportMoney(owner, dir)
      expect(counts['budget-categories']).toBe(
        await prisma.jobBudgetCategory.count({ where: { jobId: job } }),
      )
      expect(counts['customer-payments']).toBe(
        await prisma.jobPayment.count({ where: { jobId: job } }),
      )
      expect(counts['money-events']).toBe(
        await prisma.jobMoneyEvent.count({ where: { jobId: job } }),
      )
      expect(counts['labour-with-cost']).toBe(
        await prisma.memoryItem.count({
          where: {
            jobId: job,
            memoryType: 'LABOUR',
            OR: [
              { costAmount: { not: null } },
              { totalCostAmount: { not: null } },
              { refundAmount: { not: null } },
            ],
          },
        }),
      )
      expect(counts['supplier-payments']).toBe(
        await prisma.supplierAccountPayment.count({
          where: { ownerUserId: owner },
        }),
      )
      expect(counts['costed-memory-items']).toBe(
        await prisma.memoryItem.count({
          where: {
            jobId: job,
            OR: [
              { costAmount: { not: null } },
              { totalCostAmount: { not: null } },
              { refundAmount: { not: null } },
            ],
          },
        }),
      )
      for (const [table, count] of Object.entries(counts)) {
        const csv = await readFile(join(dir, `${table}.csv`), 'utf8')
        expect(csv.trimEnd().split('\r\n').length - 1).toBe(count)
      }
      expect(await snapshot()).toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('runs backend workflow steps 1–7 over a listening local HTTP server', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const get = async (path: string, user = owner) => {
      const res = await fetch(address + path, {
        headers: { 'x-pilot-user-id': user },
      })
      return { status: res.status, body: await res.json() }
    }
    const post = async (path: string, body: object, method = 'POST') => {
      const res = await fetch(address + path, {
        method,
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }
    // 1: every read model, money-heavy real database data.
    for (const path of [
      '/api/jobs',
      '/api/jobs/current',
      base(),
      `${base()}/details`,
      `${base()}/memory-view`,
      `${base()}/review-queue`,
      '/api/workshop',
    ]) {
      const res = await get(path)
      expect(res.status).toBe(200)
      scan(res.body)
    }
    // 2: gated groups, founder support preserved.
    for (const path of [
      'budget-summary',
      'budget-categories',
      'money',
      'payments',
      'labour-people',
    ]) {
      const res = await get(`${base()}/${path}`)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('FEATURE_DISABLED')
    }
    expect((await get('/api/book/money')).body.code).toBe('FEATURE_DISABLED')
    expect((await post(`${base()}/receipts`, {})).body.code).toBe(
      'FEATURE_DISABLED',
    )
    expect(
      (await get(`/api/internal/support/jobs/${job}/budget-summary`, admin))
        .status,
    ).toBe(200)
    // 3 and 4: deterministic provider at the actual worker boundary. The real
    // provider is measured separately on these same utterances by the eval.
    const texts = [
      'Picked up ten sheets of OSB from Jewson, two hundred and forty quid. Me seven hours, Kurt six.',
      'Skip hire, two fifty.',
    ]
    const ids: string[] = []
    for (const [index, text] of texts.entries()) {
      const n = await prisma.rawNote.create({
        data: {
          jobId: job, ownerUserId: owner, filedAt: new Date(),
          clientNoteId: randomUUID(),
          capturedAt: new Date('2026-07-11'),
          mimeType: 'audio/webm',
          sizeBytes: 100,
        },
      })
      ids.push(n.id)
      const t = await prisma.transcript.create({
        data: { noteId: n.id, status: 'COMPLETED', text },
      })
      await runExtraction(t.id, {
        name: 'workflow-fixture',
        model: 'deterministic',
        async extractFacts() {
          return {
            schemaVersion: 'v3-job-memory',
            facts:
              index === 1
                ? []
                : [
                    {
                      factType: 'ordered_material' as const,
                      summary: '10 sheets OSB, £240',
                      materialName: 'OSB',
                      quantity: '10',
                      unit: 'sheets',
                      supplierName: 'Jewson',
                      confidenceLabel: 'high' as const,
                      confidenceReason: 'Explicit',
                      uncertaintyFlags: [],
                      costAmount: '240',
                    },
                    {
                      factType: 'labour' as const,
                      summary: 'Me seven hours',
                      labourPerson: 'me',
                      labourHours: '7',
                      confidenceLabel: 'high' as const,
                      confidenceReason: 'Explicit',
                      uncertaintyFlags: [],
                    },
                    {
                      factType: 'labour' as const,
                      summary: 'Kurt six hours',
                      labourPerson: 'Kurt',
                      labourHours: '6',
                      confidenceLabel: 'high' as const,
                      confidenceReason: 'Explicit',
                      uncertaintyFlags: [],
                    },
                  ],
          }
        },
      })
    }
    const queue = await get(`${base()}/review-queue`)
    scan(queue.body)
    const checks = queue.body.sections
      .flatMap((section: any) => section.items)
      .filter((check: any) =>
        check.sourceContext.some((source: any) => ids.includes(source.noteId)),
      )
    expect(checks).toHaveLength(3)
    expect(
      await prisma.candidateFact.count({ where: { sourceNoteId: ids[1] } }),
    ).toBe(0)
    expect(
      await prisma.candidateFact.count({
        where: { sourceNoteId: ids[0], costAmount: { not: null } },
      }),
    ).toBe(0)
    const log = await get(`${base()}/log`)
    for (const [i, id] of ids.entries())
      expect(log.body.entries.find((e: any) => e.noteId === id).text).toBe(
        texts[i],
      )
    // Confirm first-person hours: display resolves to Mike, no hidden links.
    const check = checks.find(
      (c: any) =>
        c.proposedMemory.memoryType === 'labour' &&
        !c.proposedMemory.labourPerson,
    )
    expect(
      (
        await post(`${base()}/review-queue-decisions`, {
          action: 'confirm',
          queueItemId: check.id,
        })
      ).status,
    ).toBe(200)
    expect(
      (await get(`${base()}/memory-view`)).body.hours.people.some(
        (p: any) => p.name === 'Mike',
      ),
    ).toBe(true)
    // 5: primary typed paths and legacy edit preservation.
    expect(
      (
        await post(`${base()}/memory-items`, {
          memoryType: 'labour',
          labourPerson: 'Mike',
          labourHours: '2',
        })
      ).status,
    ).toBe(201)
    const material = await post(`${base()}/memory-items`, {
      memoryType: 'ordered_material',
      materialName: 'Plasterboard',
      quantity: '12 sheets',
    })
    expect(material.status).toBe(201)
    expect(
      (
        await post(
          `${base()}/memory-items/${material.body.id}`,
          { quantity: 'about 10 sheets' },
          'PATCH',
        )
      ).status,
    ).toBe(200)
    const costBefore = await storedMoney(bought)
    expect(
      (
        await post(
          `${base()}/memory-items/${bought}`,
          { locationOrUse: 'roof' },
          'PATCH',
        )
      ).status,
    ).toBe(200)
    expect(await storedMoney(bought)).toEqual(costBefore)
    // 6: restore historical values (quantity edits deliberately leave cost stale).
    process.env.MONEY_FEATURES_ENABLED = 'true'
    const restored = await get(`${base()}/memory-view`)
    expect(
      restored.body.sections
        .flatMap((s: any) => s.items)
        .find((m: any) => m.id === bought).totalCostAmount,
    ).toBe('240')
    delete process.env.MONEY_FEATURES_ENABLED
    // 7: real script, read-only CSV export. Stdout is row counts only.
    const dir = await mkdtemp(join(tmpdir(), 'memory-workflow-export-'))
    try {
      const counts = await exportMoney(owner, dir)
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        'src/scripts/export-money.ts',
        '--user',
        owner,
        '--out',
        join(dir, 'cli'),
      ])
      expect(stdout.trim().split('\n')).toEqual(
        Object.entries(counts).map(([name, count]) => `${name}: ${count}`),
      )
      expect(counts['money-events']).toBe(
        await prisma.jobMoneyEvent.count({ where: { jobId: job } }),
      )
      expect(counts['customer-payments']).toBe(
        await prisma.jobPayment.count({ where: { jobId: job } }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    console.log(
      'Local HTTP workflow: steps 1–7 PASS (deterministic extraction; real-provider eval separate)',
    )
  })
})
