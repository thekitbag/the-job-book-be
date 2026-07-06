// Unit tests for the shared memory-type registry — the single source of truth
// for stored/API casing, section keys, category eligibility, and spend
// eligibility.
import { describe, it, expect } from 'vitest'
import {
  MEMORY_TYPES,
  VALID_MEMORY_TYPES,
  toStoredMemoryType,
  toApiMemoryType,
  sectionKeyForMemoryType,
  sectionKeyForApiMemoryType,
  isValidMemoryType,
  isCategoryAssignableMemoryType,
  isCategoryAssignableApiMemoryType,
  isSpendMemoryType,
} from '../src/lib/memory-types.js'

const ALL_STORED = [
  'ORDERED_MATERIAL',
  'USED_MATERIAL',
  'LEFTOVER_MATERIAL',
  'SUPPLIER_DELIVERY_NOTE',
  'CUSTOMER_CHANGE',
  'WATCH_OUT',
  'LABOUR',
  'GENERAL_NOTE',
  'UNCLEAR',
]

const EXPECTED_SECTIONS: Record<string, string> = {
  ORDERED_MATERIAL: 'ordered_materials',
  USED_MATERIAL: 'used_materials',
  LEFTOVER_MATERIAL: 'leftovers',
  SUPPLIER_DELIVERY_NOTE: 'supplier_delivery_notes',
  CUSTOMER_CHANGE: 'customer_changes',
  WATCH_OUT: 'watch_outs',
  LABOUR: 'labour',
  GENERAL_NOTE: 'general_notes',
  UNCLEAR: 'unclear_items',
}

describe('registry contents', () => {
  it('covers exactly the current memory types', () => {
    expect(MEMORY_TYPES.map((t) => t.storedType).sort()).toEqual([...ALL_STORED].sort())
  })

  it.each(ALL_STORED.map((t) => [t]))('%s round-trips stored → API → stored', (stored) => {
    const api = toApiMemoryType(stored)
    expect(api).toBe(stored.toLowerCase())
    expect(toStoredMemoryType(api!)).toBe(stored)
  })

  it.each(ALL_STORED.map((t) => [t, EXPECTED_SECTIONS[t]] as const))(
    '%s maps to section %s (both casings)',
    (stored, section) => {
      expect(sectionKeyForMemoryType(stored)).toBe(section)
      expect(sectionKeyForApiMemoryType(stored.toLowerCase())).toBe(section)
    },
  )
})

describe('unknown values', () => {
  const unknowns = ['banana', '', 'ordered_materials', 'Ordered_Material', 'LABOURS']

  it.each(unknowns.map((v) => [v]))('"%s" returns null/false everywhere', (value) => {
    expect(toStoredMemoryType(value)).toBeNull()
    expect(toApiMemoryType(value)).toBeNull()
    expect(sectionKeyForMemoryType(value)).toBeNull()
    expect(sectionKeyForApiMemoryType(value)).toBeNull()
    expect(isValidMemoryType(value)).toBe(false)
    expect(isCategoryAssignableMemoryType(value)).toBe(false)
    expect(isCategoryAssignableApiMemoryType(value)).toBe(false)
    expect(isSpendMemoryType(value)).toBe(false)
  })

  it('case direction is strict: stored helpers reject API casing and vice versa', () => {
    expect(toApiMemoryType('ordered_material')).toBeNull()
    expect(toStoredMemoryType('ORDERED_MATERIAL')).toBeNull()
    expect(isValidMemoryType('ordered_material')).toBe(false)
  })
})

describe('eligibility', () => {
  it('category eligibility is exactly ORDERED_MATERIAL and LABOUR', () => {
    const eligible = ALL_STORED.filter(isCategoryAssignableMemoryType)
    expect(eligible.sort()).toEqual(['LABOUR', 'ORDERED_MATERIAL'])
    const apiEligible = ALL_STORED.map((t) => t.toLowerCase()).filter(isCategoryAssignableApiMemoryType)
    expect(apiEligible.sort()).toEqual(['labour', 'ordered_material'])
  })

  it('spend eligibility is exactly ORDERED_MATERIAL and LABOUR', () => {
    const eligible = ALL_STORED.filter(isSpendMemoryType)
    expect(eligible.sort()).toEqual(['LABOUR', 'ORDERED_MATERIAL'])
  })

  it('UNCLEAR is a valid stored type but never category/spend eligible or request-targetable', () => {
    expect(isValidMemoryType('UNCLEAR')).toBe(true)
    expect(isCategoryAssignableMemoryType('UNCLEAR')).toBe(false)
    expect(isSpendMemoryType('UNCLEAR')).toBe(false)
    expect(VALID_MEMORY_TYPES.has('unclear')).toBe(false)
  })
})

describe('VALID_MEMORY_TYPES (request-target set)', () => {
  it('is the eight lower-case non-unclear types', () => {
    expect([...VALID_MEMORY_TYPES].sort()).toEqual([
      'customer_change',
      'general_note',
      'labour',
      'leftover_material',
      'ordered_material',
      'supplier_delivery_note',
      'used_material',
      'watch_out',
    ])
  })
})
