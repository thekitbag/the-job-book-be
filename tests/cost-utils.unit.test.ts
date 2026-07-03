import { describe, it, expect } from 'vitest'
import {
  STRICT_DECIMAL_RE,
  strictParsePositive,
  formatUnitCostLabel,
  formatLineTotalLabel,
  deriveSafeLineTotal,
  deriveSafeMaterialTotal,
  hasCostConflict,
} from '../src/lib/cost-utils.js'

// ── deriveSafeMaterialTotal (authoritative stored-total rule) ──────────────────

describe('deriveSafeMaterialTotal', () => {
  it('derives when quantity, unit, each unit cost, and currency are all clear', () => {
    expect(deriveSafeMaterialTotal('5', 'sheets', '20', 'GBP', 'each')).toBe('100')
    expect(deriveSafeMaterialTotal('2.5', 'm', '4', 'GBP', 'each')).toBe('10')
  })
  it('does not derive without a unit', () => {
    expect(deriveSafeMaterialTotal('5', null, '20', 'GBP', 'each')).toBeNull()
    expect(deriveSafeMaterialTotal('5', '   ', '20', 'GBP', 'each')).toBeNull()
  })
  it('does not derive without a currency', () => {
    expect(deriveSafeMaterialTotal('5', 'sheets', '20', null, 'each')).toBeNull()
  })
  it('does not derive for non-each qualifiers', () => {
    for (const q of ['total', 'approx', 'unknown', 'per_hour', null]) {
      expect(deriveSafeMaterialTotal('5', 'sheets', '20', 'GBP', q)).toBeNull()
    }
  })
  it('does not derive for a non-numeric or non-positive quantity', () => {
    expect(deriveSafeMaterialTotal('about 5', 'sheets', '20', 'GBP', 'each')).toBeNull()
    expect(deriveSafeMaterialTotal('0', 'sheets', '20', 'GBP', 'each')).toBeNull()
  })
})

// ── STRICT_DECIMAL_RE ─────────────────────────────────────────────────────────

describe('STRICT_DECIMAL_RE', () => {
  it('accepts integer strings', () => {
    expect(STRICT_DECIMAL_RE.test('8')).toBe(true)
    expect(STRICT_DECIMAL_RE.test('600')).toBe(true)
  })

  it('accepts decimal strings', () => {
    expect(STRICT_DECIMAL_RE.test('5.50')).toBe(true)
    expect(STRICT_DECIMAL_RE.test('2.5')).toBe(true)
  })

  it('rejects strings with units', () => {
    expect(STRICT_DECIMAL_RE.test('8 bags')).toBe(false)
    expect(STRICT_DECIMAL_RE.test('5 each')).toBe(false)
  })

  it('rejects approximate strings', () => {
    expect(STRICT_DECIMAL_RE.test('about 8')).toBe(false)
    expect(STRICT_DECIMAL_RE.test('5-ish')).toBe(false)
  })

  it('rejects currency-prefixed strings', () => {
    expect(STRICT_DECIMAL_RE.test('£5')).toBe(false)
    expect(STRICT_DECIMAL_RE.test('€10')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(STRICT_DECIMAL_RE.test('')).toBe(false)
  })
})

// ── strictParsePositive ───────────────────────────────────────────────────────

describe('strictParsePositive', () => {
  it('parses valid positive decimal strings', () => {
    expect(strictParsePositive('8')).toBe(8)
    expect(strictParsePositive('5.5')).toBe(5.5)
    expect(strictParsePositive('600')).toBe(600)
  })

  it('returns null for zero', () => {
    expect(strictParsePositive('0')).toBeNull()
  })

  it('returns null for non-numeric strings', () => {
    expect(strictParsePositive('8 bags')).toBeNull()
    expect(strictParsePositive('about 5')).toBeNull()
    expect(strictParsePositive('£5')).toBeNull()
  })

  it('returns null for null/undefined', () => {
    expect(strictParsePositive(null)).toBeNull()
    expect(strictParsePositive(undefined)).toBeNull()
  })
})

// ── formatUnitCostLabel ───────────────────────────────────────────────────────

describe('formatUnitCostLabel', () => {
  it('returns "£5 each" for GBP each', () => {
    expect(formatUnitCostLabel('5', 'GBP', 'each')).toBe('£5 each')
  })

  it('returns "EUR 30 each" for non-GBP each', () => {
    expect(formatUnitCostLabel('30', 'EUR', 'each')).toBe('EUR 30 each')
  })

  it('returns null when qualifier is not each', () => {
    expect(formatUnitCostLabel('600', 'GBP', 'total')).toBeNull()
    expect(formatUnitCostLabel('50', 'GBP', 'approx')).toBeNull()
    expect(formatUnitCostLabel('50', 'GBP', 'unknown')).toBeNull()
  })

  it('returns null when costAmount is missing', () => {
    expect(formatUnitCostLabel(null, 'GBP', 'each')).toBeNull()
  })

  it('returns null when currency is missing', () => {
    expect(formatUnitCostLabel('5', null, 'each')).toBeNull()
  })
})

// ── formatLineTotalLabel ──────────────────────────────────────────────────────

describe('formatLineTotalLabel', () => {
  it('returns "£600 total" for GBP', () => {
    expect(formatLineTotalLabel('600', 'GBP')).toBe('£600 total')
  })

  it('returns "EUR 600 total" for non-GBP', () => {
    expect(formatLineTotalLabel('600', 'EUR')).toBe('EUR 600 total')
  })

  it('returns null when totalCostAmount is missing', () => {
    expect(formatLineTotalLabel(null, 'GBP')).toBeNull()
  })

  it('returns null when currency is missing', () => {
    expect(formatLineTotalLabel('600', null)).toBeNull()
  })
})

// ── deriveSafeLineTotal ───────────────────────────────────────────────────────

describe('deriveSafeLineTotal', () => {
  it('derives 8 × £5 = £40 (8 bags of hardcore at £5 each)', () => {
    expect(deriveSafeLineTotal('8', '5', 'each')).toBe('40')
  })

  it('derives 10 × £30 = £300 (10 bags at £30 each)', () => {
    expect(deriveSafeLineTotal('10', '30', 'each')).toBe('300')
  })

  it('derives 12 × £50 = £600', () => {
    expect(deriveSafeLineTotal('12', '50', 'each')).toBe('600')
  })

  it('handles decimal quantities and costs', () => {
    expect(deriveSafeLineTotal('2.5', '4', 'each')).toBe('10')
  })

  it('rounds to 2 decimal places', () => {
    expect(deriveSafeLineTotal('3', '1.67', 'each')).toBe('5.01')
  })

  it('returns null when qualifier is total (explicit total, not per-item)', () => {
    expect(deriveSafeLineTotal('12', '600', 'total')).toBeNull()
  })

  it('returns null when qualifier is approx', () => {
    expect(deriveSafeLineTotal('8', '5', 'approx')).toBeNull()
  })

  it('returns null when qualifier is unknown (bare cost — ambiguous basis)', () => {
    expect(deriveSafeLineTotal('8', '50', 'unknown')).toBeNull()
  })

  it('returns null when qualifier is missing', () => {
    expect(deriveSafeLineTotal('8', '5', null)).toBeNull()
  })

  it('returns null when quantity is non-numeric ("8 bags")', () => {
    expect(deriveSafeLineTotal('8 bags', '5', 'each')).toBeNull()
  })

  it('returns null when costAmount is non-numeric ("5 each")', () => {
    expect(deriveSafeLineTotal('8', '5 each', 'each')).toBeNull()
  })

  it('returns null when quantity is missing', () => {
    expect(deriveSafeLineTotal(null, '5', 'each')).toBeNull()
  })

  it('returns null when costAmount is missing', () => {
    expect(deriveSafeLineTotal('8', null, 'each')).toBeNull()
  })
})

// ── hasCostConflict ───────────────────────────────────────────────────────────

describe('hasCostConflict', () => {
  it('returns false when no totalCostAmount', () => {
    expect(hasCostConflict('8', '5', 'each', null)).toBe(false)
  })

  it('returns false when qualifier is not each (explicit total, no expected derivation)', () => {
    expect(hasCostConflict('12', '600', 'total', '600')).toBe(false)
  })

  it('returns false when derived matches stored total', () => {
    expect(hasCostConflict('8', '5', 'each', '40')).toBe(false)
  })

  it('returns true when derived differs from stored total', () => {
    expect(hasCostConflict('8', '5', 'each', '45')).toBe(true)
  })

  it('returns false when quantity is non-numeric (no derivation possible)', () => {
    expect(hasCostConflict('8 bags', '5', 'each', '45')).toBe(false)
  })

  it('returns false when costAmount is approximate (no derivation possible)', () => {
    expect(hasCostConflict('8', 'about 5', 'each', '45')).toBe(false)
  })

  it('returns false when epsilon difference is within tolerance', () => {
    // 3 × 1.67 = 5.01 exactly after rounding, not a conflict
    expect(hasCostConflict('3', '1.67', 'each', '5.01')).toBe(false)
  })
})
