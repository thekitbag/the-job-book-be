// Unit tests for the shared memory-related request validators.
import { describe, it, expect } from 'vitest'
import {
  isValidDecimalString,
  validateOptionalDecimal,
  validateOptionalCostQualifier,
  validateOptionalUncertaintyResolution,
  validateMemoryTargetType,
  validateBudgetCategoryRef,
  VALID_COST_QUALIFIERS,
  VALID_UNCERTAINTY_RESOLUTIONS,
} from '../src/lib/request-validation.js'

describe('validateOptionalDecimal', () => {
  const valid = ['0', '5', '40', '0.5', '12.75']
  it.each(valid.map((v) => [v]))('accepts "%s"', (v) => {
    expect(isValidDecimalString(v)).toBe(true)
    expect(validateOptionalDecimal(v, 'costAmount')).toBeNull()
  })

  const invalid = ['£40', '5 each', 'abc', '-5', '.5', '5.', '5,50', '', ' 5', '1e3']
  it.each(invalid.map((v) => [v]))('rejects "%s" with the field-named message', (v) => {
    expect(isValidDecimalString(v)).toBe(false)
    expect(validateOptionalDecimal(v, 'totalCostAmount')).toEqual({
      code: 'INVALID_FIELD',
      message: 'totalCostAmount must be a decimal string',
    })
  })

  it('rejects non-string values', () => {
    expect(validateOptionalDecimal(40, 'costAmount')).toMatchObject({ code: 'INVALID_FIELD' })
    expect(validateOptionalDecimal({}, 'costAmount')).toMatchObject({ code: 'INVALID_FIELD' })
  })

  it('accepts null and undefined (optional field)', () => {
    expect(validateOptionalDecimal(null, 'labourHours')).toBeNull()
    expect(validateOptionalDecimal(undefined, 'labourHours')).toBeNull()
  })
})

describe('validateOptionalCostQualifier', () => {
  it.each([...VALID_COST_QUALIFIERS].map((q) => [q]))('accepts "%s"', (q) => {
    expect(validateOptionalCostQualifier(q)).toBeNull()
  })

  it('the accepted set is exactly each/total/per_hour/approx/unknown', () => {
    expect([...VALID_COST_QUALIFIERS].sort()).toEqual(['approx', 'each', 'per_hour', 'total', 'unknown'])
  })

  it('rejects unknown qualifiers with the exact message', () => {
    expect(validateOptionalCostQualifier('weekly')).toEqual({
      code: 'INVALID_FIELD',
      message: 'costQualifier must be each, total, per_hour, approx, or unknown',
    })
  })

  it('supports a field-name prefix for nested bodies', () => {
    expect(validateOptionalCostQualifier('weekly', 'corrected.costQualifier')?.message).toBe(
      'corrected.costQualifier must be each, total, per_hour, approx, or unknown',
    )
  })

  it('accepts null and undefined', () => {
    expect(validateOptionalCostQualifier(null)).toBeNull()
    expect(validateOptionalCostQualifier(undefined)).toBeNull()
  })
})

describe('validateOptionalUncertaintyResolution', () => {
  it.each([...VALID_UNCERTAINTY_RESOLUTIONS].map((v) => [v]))('accepts "%s"', (v) => {
    expect(validateOptionalUncertaintyResolution(v)).toBeNull()
  })

  it('the accepted set is exactly resolved/still_unsure', () => {
    expect([...VALID_UNCERTAINTY_RESOLUTIONS].sort()).toEqual(['resolved', 'still_unsure'])
  })

  it('rejects unknown values with the exact message', () => {
    expect(validateOptionalUncertaintyResolution('maybe')).toEqual({
      code: 'INVALID_FIELD',
      message: 'uncertaintyResolution must be resolved or still_unsure',
    })
  })

  it('accepts null and undefined', () => {
    expect(validateOptionalUncertaintyResolution(null)).toBeNull()
    expect(validateOptionalUncertaintyResolution(undefined)).toBeNull()
  })
})

describe('validateMemoryTargetType', () => {
  const validTargets = [
    'ordered_material', 'used_material', 'leftover_material', 'supplier_delivery_note',
    'customer_change', 'watch_out', 'labour', 'general_note',
  ]

  it.each(validTargets.map((t) => [t]))('accepts registry target type "%s"', (t) => {
    expect(validateMemoryTargetType(t)).toBeNull()
  })

  it.each([['unclear'], ['banana'], ['ORDERED_MATERIAL'], ['']])(
    'rejects "%s" with the exact message',
    (t) => {
      expect(validateMemoryTargetType(t)).toEqual({
        code: 'INVALID_FIELD',
        message: 'memoryType must be a valid non-unclear memory type',
      })
    },
  )

  it('supports a field-name prefix for nested bodies', () => {
    expect(validateMemoryTargetType('unclear', 'corrected.memoryType')?.message).toBe(
      'corrected.memoryType must be a valid non-unclear memory type',
    )
  })
})

describe('validateBudgetCategoryRef', () => {
  it('accepts a string and null', () => {
    expect(validateBudgetCategoryRef('cat-1')).toBeNull()
    expect(validateBudgetCategoryRef(null)).toBeNull()
  })

  it.each([[7], [{}], [true], [['cat-1']]])('rejects %o with the exact message', (v) => {
    expect(validateBudgetCategoryRef(v)).toEqual({
      code: 'INVALID_FIELD',
      message: 'budgetCategoryId must be a string or null',
    })
  })

  it('supports a field-name prefix for nested bodies', () => {
    expect(validateBudgetCategoryRef(7, 'corrected.budgetCategoryId')?.message).toBe(
      'corrected.budgetCategoryId must be a string or null',
    )
  })
})
