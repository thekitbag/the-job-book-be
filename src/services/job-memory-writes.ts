import { prisma } from '../db/client.js'
import type { CreateMemoryItemInput, MemoryItemPatch } from './memory-items.js'
import { ErrorCode } from '../types/errors.js'
import {
  MATERIAL_TYPES,
  materialAmount,
  memoryLabel,
  ignoreMoneyInput,
} from '../lib/job-memory.js'
import { ukLocalDayString, ukLocalNoon } from '../lib/dates.js'
import { isValidDecimalString } from '../lib/request-validation.js'

function text(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | null {
  if (
    (value == null || (typeof value === 'string' && !value.trim())) &&
    !required
  )
    return null
  if (value == null || value === '')
    throw { code: ErrorCode.MISSING_FIELD, message: `${field} is required` }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: `${field} must be a non-empty string of at most ${max} characters`,
    }
  }
  return value.trim()
}
function hoursDay(value: unknown): Date {
  const today = ukLocalDayString(new Date())
  if (value === undefined) return ukLocalNoon(today)
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(new Date(value).getTime()) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value > today
  ) {
    throw {
      code: ErrorCode.INVALID_FIELD,
      message: 'happenedAt must be an ISO date, not in the future',
    }
  }
  return ukLocalNoon(value)
}
const include = {
  sourceFact: {
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
  },
} as const

type Existing = NonNullable<
  Awaited<ReturnType<typeof prisma.memoryItem.findFirst>>
>
// Only memory columns enter this data object. Money columns and links are absent,
// including on updates where defaults or recalculation would destroy history.
function fields(
  input: CreateMemoryItemInput | MemoryItemPatch,
  existing?: Existing,
) {
  input = ignoreMoneyInput(input)
  const memoryType = (
    input.memoryType ??
    existing?.memoryType ??
    ''
  ).toUpperCase()
  const data: Record<string, unknown> = { memoryType }
  if (MATERIAL_TYPES.has(memoryType)) {
    if (!existing && memoryType === 'RETURNED_MATERIAL')
      throw {
        code: ErrorCode.INVALID_FIELD,
        message: 'Use the return action for returned materials',
      }
    const materialName = text(
      input.materialName === undefined
        ? existing?.materialName
        : input.materialName,
      'materialName',
      120,
      true,
    )!
    const supplierName =
      input.supplierName === undefined
        ? (existing?.supplierName ?? null)
        : text(input.supplierName, 'supplierName', 80, false)
    const locationOrUse =
      input.locationOrUse === undefined
        ? (existing?.locationOrUse ?? null)
        : text(input.locationOrUse, 'locationOrUse', 200, false)
    const currentAmount = existing ? materialAmount(existing) : null
    const quantity =
      input.quantity === undefined && existing
        ? currentAmount
        : text(input.quantity, 'quantity', 60, true)
    Object.assign(data, { materialName, supplierName, locationOrUse })
    if (
      !existing ||
      (input.quantity !== undefined && input.quantity === currentAmount)
    ) {
      if (!existing) Object.assign(data, { quantity, unit: null })
    } else if (input.quantity !== undefined)
      Object.assign(data, { quantity, unit: null })
    data.summary = memoryLabel({
      memoryType,
      materialName,
      quantity,
      supplierName,
      locationOrUse,
    })
    if (!existing) data.happenedAt = ukLocalNoon(ukLocalDayString(new Date()))
  } else if (memoryType === 'LABOUR') {
    data.labourPerson = text(
      input.labourPerson === undefined
        ? existing?.labourPerson
        : input.labourPerson,
      'labourPerson',
      60,
      true,
    )
    const hours =
      input.labourHours === undefined
        ? existing?.labourHours
        : input.labourHours
    if (hours == null)
      throw {
        code: ErrorCode.MISSING_FIELD,
        message: 'labourHours is required',
      }
    if (
      !isValidDecimalString(hours) ||
      Number(hours) <= 0 ||
      Number(hours) > 24
    )
      throw {
        code: ErrorCode.INVALID_FIELD,
        message: 'labourHours must be a decimal greater than 0 and at most 24',
      }
    data.labourHours = hours
    data.labourTask =
      input.labourTask === undefined
        ? (existing?.labourTask ?? null)
        : input.labourTask
    data.happenedAt =
      existing && input.happenedAt === undefined
        ? existing.happenedAt
        : hoursDay(input.happenedAt)
    data.summary = memoryLabel(data)
  } else if (
    memoryType === 'GENERAL_NOTE' ||
    (existing &&
      ['CUSTOMER_CHANGE', 'WATCH_OUT', 'SUPPLIER_DELIVERY_NOTE'].includes(
        memoryType,
      ))
  ) {
    data.summary = text(
      input.summary ?? existing?.summary,
      'summary',
      10000,
      true,
    )
  } else
    throw { code: ErrorCode.INVALID_FIELD, message: 'Unsupported memory type' }
  return data
}
export async function createJobMemory(
  jobId: string,
  userId: string,
  input: CreateMemoryItemInput,
) {
  const data = fields(input)
  return prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: {
        jobId,
        decidedBy: userId,
        action: 'ADD_MISSING',
        sourceCandidateFactIds: [],
      },
    })
    return tx.memoryItem.create({
      data: {
        ...data,
        jobId,
        reviewDecisionId: decision.id,
        isManual: true,
      } as never,
      include,
    })
  })
}
export async function patchJobMemory(
  existing: Existing,
  patch: MemoryItemPatch,
) {
  const data = fields(patch, existing)
  if (patch.uncertaintyResolution === 'resolved')
    data.unresolvedFlags = existing.unresolvedFlags.filter((f) =>
      /cost|budget|paid/i.test(f),
    )
  return prisma.memoryItem.update({ where: { id: existing.id }, data, include })
}
