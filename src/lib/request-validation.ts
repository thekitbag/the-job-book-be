// Shared request-validation primitives for memory-related route inputs
// (memory-items and review-queue). Each helper returns a ValidationError to
// send as a 400, or null when the value is acceptable — routes keep owning
// reply handling and any MISSING_FIELD context of their own.
//
// Behaviour contract (matches the previous per-route checks exactly):
//   · optional fields: null/undefined always pass; only present, malformed
//     values fail;
//   · error messages are `${fieldName} …`, so callers can prefix nested
//     fields (e.g. 'corrected.costAmount').
//
// Pure module: no Prisma, no route/service imports.
import { ErrorCode } from '../types/errors.js'
import { STRICT_DECIMAL_RE } from './cost-utils.js'
import { VALID_MEMORY_TYPES } from './memory-types.js'

export interface ValidationError {
  code: ErrorCode
  message: string
}

const invalid = (message: string): ValidationError => ({ code: ErrorCode.INVALID_FIELD, message })

export const VALID_COST_QUALIFIERS: ReadonlySet<string> = new Set([
  'each', 'total', 'per_hour', 'approx', 'unknown',
])

export const VALID_UNCERTAINTY_RESOLUTIONS: ReadonlySet<string> = new Set([
  'resolved', 'still_unsure',
])

// Plain decimal string: digits with an optional fraction — no currency symbols,
// units, or approximations ('£40', '5 each', 'abc' all fail).
export function isValidDecimalString(v: unknown): v is string {
  return typeof v === 'string' && STRICT_DECIMAL_RE.test(v)
}

// Optional decimal-string field (costAmount, totalCostAmount, labourHours, …).
export function validateOptionalDecimal(value: unknown, fieldName: string): ValidationError | null {
  if (value == null) return null
  if (!isValidDecimalString(value)) return invalid(`${fieldName} must be a decimal string`)
  return null
}

// Optional cost qualifier.
export function validateOptionalCostQualifier(
  value: unknown,
  fieldName = 'costQualifier',
): ValidationError | null {
  if (value == null) return null
  if (typeof value !== 'string' || !VALID_COST_QUALIFIERS.has(value)) {
    return invalid(`${fieldName} must be each, total, per_hour, approx, or unknown`)
  }
  return null
}

// Optional uncertainty resolution.
export function validateOptionalUncertaintyResolution(value: unknown): ValidationError | null {
  if (value == null) return null
  if (typeof value !== 'string' || !VALID_UNCERTAINTY_RESOLUTIONS.has(value)) {
    return invalid('uncertaintyResolution must be resolved or still_unsure')
  }
  return null
}

// A present request target memory type: must be one of the lower-case,
// non-unclear registry types. Missing-field handling stays in the routes
// because the MISSING_FIELD context differs per endpoint.
export function validateMemoryTargetType(value: unknown, fieldName = 'memoryType'): ValidationError | null {
  if (typeof value !== 'string' || !VALID_MEMORY_TYPES.has(value)) {
    return invalid(`${fieldName} must be a valid non-unclear memory type`)
  }
  return null
}

// Shape-only check for a provided budgetCategoryId: string selects a category,
// null clears/uncategorised. Same-job and archived-category enforcement stays
// in the services. Callers only invoke this when the field is present in the
// body ('field' in body), so undefined is rejected like any other non-string.
export function validateBudgetCategoryRef(
  value: unknown,
  fieldName = 'budgetCategoryId',
): ValidationError | null {
  if (value === null || typeof value === 'string') return null
  return invalid(`${fieldName} must be a string or null`)
}
