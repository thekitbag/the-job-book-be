import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { strictParsePositive } from '../lib/cost-utils.js'
import { classifySpend, sumKnownSpend } from '../lib/spend-classification.js'

export const MAX_LABOUR_PERSON_NAME_LENGTH = 80

export function normalizeLabourPersonName(name: string): string {
  return name.trim().toLowerCase()
}

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

export function normalizeLabourPerson(p: {
  id: string; jobId: string; name: string; defaultHourlyRateAmount: string | null
  defaultHourlyRateCurrency: string | null; createdAt: Date; updatedAt: Date
}) {
  return {
    id: p.id, jobId: p.jobId, name: p.name,
    defaultHourlyRateAmount: p.defaultHourlyRateAmount,
    defaultHourlyRateCurrency: p.defaultHourlyRateAmount === null ? null : 'GBP' as const,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  }
}

export async function requireJobLabourPerson(jobId: string, personId: string) {
  const person = await prisma.labourPerson.findFirst({ where: { id: personId, jobId, isArchived: false } })
  if (!person) throw { code: ErrorCode.LABOUR_PERSON_NOT_FOUND, message: 'Labour person not found' }
  return person
}

export async function getActiveLabourPeople(jobId: string) {
  return prisma.labourPerson.findMany({ where: { jobId, isArchived: false }, orderBy: [{ name: 'asc' }] })
}

export function matchLabourPersonByName<T extends { normalizedName: string }>(people: T[], text: string | null | undefined): T | null {
  const norm = text ? normalizeLabourPersonName(text) : ''
  return norm === '' ? null : people.find((p) => p.normalizedName === norm) ?? null
}

export async function listLabourPeople(jobId: string, userId: string) {
  await verifyJobOwnership(jobId, userId)
  const [people, labourItems] = await Promise.all([
    getActiveLabourPeople(jobId),
    prisma.memoryItem.findMany({ where: { jobId, isRemoved: false, memoryType: 'LABOUR' } }),
  ])
  const byPerson = new Map<string, typeof labourItems>()
  for (const item of labourItems) if (item.labourPersonId) {
    const items = byPerson.get(item.labourPersonId) ?? []
    items.push(item); byPerson.set(item.labourPersonId, items)
  }
  const peopleWithStats = people.map((person) => {
    const items = byPerson.get(person.id) ?? []
    const hours = items.reduce((sum, item) => sum + (strictParsePositive(item.labourHours) ?? 0), 0)
    const jobHours = items.some((item) => strictParsePositive(item.labourHours) !== null) ? String(Math.round(hours * 100) / 100) : null
    const costs = items.map(classifySpend).flatMap((c) => c.kind === 'included' ? [c.row.lineTotalAmount] : [])
    const jobLabourCostAmount = costs.length ? sumKnownSpend(costs) : null
    return { ...normalizeLabourPerson(person), jobHours, jobHoursLabel: jobHours === null ? null : `${jobHours}h`, jobLabourCostAmount,
      jobLabourCostCurrency: jobLabourCostAmount === null ? null : 'GBP' as const,
      jobLabourCostLabel: jobLabourCostAmount === null ? null : `£${jobLabourCostAmount} budget cost`, _hasEntries: items.length > 0 }
  })
  peopleWithStats.sort((a, b) => a._hasEntries === b._hasEntries ? a.name.localeCompare(b.name) : a._hasEntries ? -1 : 1)
  return { jobId, people: peopleWithStats.map(({ _hasEntries, ...person }) => person) }
}

export interface CreateLabourPersonInput { name: string; defaultHourlyRateAmount?: string | null; defaultHourlyRateCurrency?: string | null }
export interface PatchLabourPersonInput { name?: string; defaultHourlyRateAmount?: string | null; defaultHourlyRateCurrency?: string | null }

async function assertNoActiveDuplicate(jobId: string, normalizedName: string, excludePersonId?: string) {
  const existing = await prisma.labourPerson.findFirst({ where: { jobId, normalizedName, isArchived: false, ...(excludePersonId ? { id: { not: excludePersonId } } : {}) } })
  if (existing) throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists on this job' }
}

export async function createLabourPerson(jobId: string, userId: string, input: CreateLabourPersonInput) {
  await verifyJobOwnership(jobId, userId)
  const name = input.name.trim(); const normalizedName = normalizeLabourPersonName(name)
  await assertNoActiveDuplicate(jobId, normalizedName)
  try {
    return normalizeLabourPerson(await prisma.labourPerson.create({ data: { jobId, name, normalizedName,
      defaultHourlyRateAmount: input.defaultHourlyRateAmount ?? null,
      defaultHourlyRateCurrency: input.defaultHourlyRateAmount == null ? null : 'GBP' } }))
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists on this job' }
    throw err
  }
}

export async function patchLabourPerson(jobId: string, personId: string, userId: string, patch: PatchLabourPersonInput) {
  await verifyJobOwnership(jobId, userId)
  const existing = await requireJobLabourPerson(jobId, personId)
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim(); const normalizedName = normalizeLabourPersonName(name)
    if (normalizedName !== existing.normalizedName) await assertNoActiveDuplicate(jobId, normalizedName, personId)
    data.name = name; data.normalizedName = normalizedName
  }
  if (patch.defaultHourlyRateAmount !== undefined) {
    data.defaultHourlyRateAmount = patch.defaultHourlyRateAmount
    data.defaultHourlyRateCurrency = patch.defaultHourlyRateAmount === null ? null : 'GBP'
  }
  try { return normalizeLabourPerson(await prisma.labourPerson.update({ where: { id: personId }, data })) }
  catch (err: unknown) { if ((err as { code?: string }).code === 'P2002') throw { code: ErrorCode.LABOUR_PERSON_ALREADY_EXISTS, message: 'A labour person with this name already exists on this job' }; throw err }
}
