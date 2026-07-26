// Lightweight, user-owned labour people. Reusable across a user's jobs (keyed by
// ownerUserId, not jobId) but always reached through an owned job route. NOT
// payroll/staff management — just a name, an optional assumed rate, and a default
// Budget treatment that new labour entries can inherit.
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { strictParsePositive } from '../lib/cost-utils.js'
import { classifySpend, sumKnownSpend } from '../lib/spend-classification.js'

export const MAX_LABOUR_PERSON_NAME_LENGTH = 80

export type ApiBudgetTreatment = 'counts_toward_budget' | 'hours_only'

export function normalizeLabourPersonName(name: string): string {
  return name.trim().toLowerCase()
}

export function toApiTreatment(t: string): ApiBudgetTreatment {
  return t === 'COUNTS_TOWARD_BUDGET' ? 'counts_toward_budget' : 'hours_only'
}
export function toDbTreatment(t: ApiBudgetTreatment): 'COUNTS_TOWARD_BUDGET' | 'HOURS_ONLY' {
  return t === 'counts_toward_budget' ? 'COUNTS_TOWARD_BUDGET' : 'HOURS_ONLY'
}

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

interface PersonRow {
  id: string
  name: string
  defaultHourlyRateAmount: string | null
  defaultHourlyRateCurrency: string | null
  defaultBudgetTreatment: string
  createdAt: Date
  updatedAt: Date
}

export function normalizeLabourPerson(p: PersonRow) {
  return {
    id: p.id,
    name: p.name,
    defaultHourlyRateAmount: p.defaultHourlyRateAmount,
    defaultHourlyRateCurrency: p.defaultHourlyRateAmount !== null ? ('GBP' as const) : null,
    defaultBudgetTreatment: toApiTreatment(p.defaultBudgetTreatment),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

// Active labour person owned by the user, or 404. Shared with the memory-item
// write paths so an entry can only link to a person the caller owns.
export async function requireOwnedLabourPerson(userId: string, personId: string) {
  const person = await prisma.labourPerson.findFirst({
    where: { id: personId, ownerUserId: userId, isArchived: false },
  })
  if (!person) throw { code: ErrorCode.LABOUR_PERSON_NOT_FOUND, message: 'Labour person not found' }
  return person
}

export async function getActiveLabourPeople(userId: string) {
  return prisma.labourPerson.findMany({
    where: { ownerUserId: userId, isArchived: false },
    orderBy: [{ name: 'asc' }],
  })
}

// Match a free-text labour person name to a single active person for the owner
// by exact normalized name. Returns null on no match; the active-name unique
// index guarantees at most one, so a match is never ambiguous.
export function matchLabourPersonByName<T extends { normalizedName: string }>(
  people: T[],
  text: string | null | undefined,
): T | null {
  const norm = text ? normalizeLabourPersonName(text) : ''
  if (norm === '') return null
  return people.find((p) => p.normalizedName === norm) ?? null
}

// ── List with per-job stats ───────────────────────────────────────────────────

export async function listLabourPeople(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)

  const [people, labourItems] = await Promise.all([
    getActiveLabourPeople(userId),
    prisma.memoryItem.findMany({
      where: { jobId, isRemoved: false, memoryType: 'LABOUR' },
    }),
  ])

  // Per-person job rollups. Hours count every entry with strict-positive hours,
  // regardless of Budget treatment; job budget cost is the shared classifier's
  // included (budget-enabled, trusted GBP) labour only.
  const byPerson = new Map<string, typeof labourItems>()
  for (const m of labourItems) {
    if (!m.labourPersonId) continue
    const list = byPerson.get(m.labourPersonId)
    if (list) list.push(m)
    else byPerson.set(m.labourPersonId, [m])
  }

  const withStats = people.map((p) => {
    const items = byPerson.get(p.id) ?? []
    const hoursNum = items.reduce((s, m) => s + (strictParsePositive(m.labourHours) ?? 0), 0)
    const anyHours = items.some((m) => strictParsePositive(m.labourHours) !== null)
    const jobHours = anyHours ? String(Math.round(hoursNum * 100) / 100) : null

    const includedTotals = items
      .map(classifySpend)
      .filter((c): c is Extract<ReturnType<typeof classifySpend>, { kind: 'included' }> => c.kind === 'included')
      .map((c) => c.row.lineTotalAmount)
    const jobBudgetCostAmount = includedTotals.length > 0 ? sumKnownSpend(includedTotals) : null

    // "Without rate" = an entry with no safe trusted GBP total to cost from.
    const hasEntriesWithoutRate = items.some(
      (m) => strictParsePositive(m.totalCostAmount) === null || m.costCurrency !== 'GBP',
    )

    return {
      ...normalizeLabourPerson(p),
      jobHours,
      jobHoursLabel: jobHours !== null ? `${jobHours}h` : null,
      jobBudgetCostAmount,
      jobBudgetCostCurrency: jobBudgetCostAmount !== null ? ('GBP' as const) : null,
      jobBudgetCostLabel: jobBudgetCostAmount !== null ? `£${jobBudgetCostAmount} budget cost` : null,
      hasEntriesWithoutRate,
      _hasJobEntries: items.length > 0,
    }
  })

  // People with entries on this job first (then by name); others by name.
  withStats.sort((a, b) => {
    if (a._hasJobEntries !== b._hasJobEntries) return a._hasJobEntries ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return {
    jobId,
    people: withStats.map(({ _hasJobEntries, ...person }) => person),
  }
}

// ── Create / update ───────────────────────────────────────────────────────────

export interface CreateLabourPersonInput {
  name: string
  defaultHourlyRateAmount?: string | null
  defaultHourlyRateCurrency?: string | null
  defaultBudgetTreatment: ApiBudgetTreatment
}

// Guards active-name uniqueness per owner. The partial unique index is the
// race-proof backstop; this check gives the friendly LABOUR_PERSON_ALREADY_EXISTS.
async function assertNoActiveDuplicate(userId: string, normalizedName: string, excludePersonId?: string) {
  const existing = await prisma.labourPerson.findFirst({
    where: { ownerUserId: userId, normalizedName, isArchived: false, ...(excludePersonId ? { id: { not: excludePersonId } } : {}) },
  })
  if (existing) throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists' }
}

export async function createLabourPerson(jobId: string, userId: string, input: CreateLabourPersonInput) {
  await verifyJobOwnership(jobId, userId)

  const name = input.name.trim()
  const normalizedName = normalizeLabourPersonName(name)
  await assertNoActiveDuplicate(userId, normalizedName)

  const rate = input.defaultHourlyRateAmount ?? null
  try {
    const created = await prisma.labourPerson.create({
      data: {
        ownerUserId: userId,
        name,
        normalizedName,
        defaultHourlyRateAmount: rate,
        defaultHourlyRateCurrency: rate !== null ? 'GBP' : null,
        defaultBudgetTreatment: toDbTreatment(input.defaultBudgetTreatment),
      },
    })
    return normalizeLabourPerson(created)
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists' }
    }
    throw err
  }
}

export interface PatchLabourPersonInput {
  name?: string
  defaultHourlyRateAmount?: string | null
  defaultHourlyRateCurrency?: string | null
  defaultBudgetTreatment?: ApiBudgetTreatment
}

export async function patchLabourPerson(
  jobId: string,
  personId: string,
  userId: string,
  patch: PatchLabourPersonInput,
) {
  await verifyJobOwnership(jobId, userId)
  const existing = await requireOwnedLabourPerson(userId, personId)

  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    const normalizedName = normalizeLabourPersonName(name)
    if (normalizedName !== existing.normalizedName) {
      await assertNoActiveDuplicate(userId, normalizedName, personId)
    }
    data.name = name
    data.normalizedName = normalizedName
  }
  // rate + currency move together; null clears both.
  if (patch.defaultHourlyRateAmount !== undefined) {
    if (patch.defaultHourlyRateAmount === null) {
      data.defaultHourlyRateAmount = null
      data.defaultHourlyRateCurrency = null
    } else {
      data.defaultHourlyRateAmount = patch.defaultHourlyRateAmount
      data.defaultHourlyRateCurrency = 'GBP'
    }
  }
  if (patch.defaultBudgetTreatment !== undefined) {
    data.defaultBudgetTreatment = toDbTreatment(patch.defaultBudgetTreatment)
  }

  try {
    const updated = await prisma.labourPerson.update({ where: { id: personId }, data })
    return normalizeLabourPerson(updated)
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists' }
    }
    throw err
  }
}
