// Single domain registry for memory/fact types and their stable properties:
// stored/API casing, memory-view section keys, budget-category eligibility, and
// known-spend eligibility. Services and routes read from here instead of
// keeping their own copies, so a new memory type is added in one place.
//
// Case direction is explicit throughout:
//   stored/internal values are upper-case  — 'ORDERED_MATERIAL'
//   API request/response values are lower-case — 'ordered_material'
//
// This module is pure: no Prisma, no route/service imports.

export interface MemoryTypeInfo {
  storedType: string
  apiType: string
  sectionKey: string
  canAssignBudgetCategory: boolean
  canContributeSpend: boolean
}

export const MEMORY_TYPES: readonly MemoryTypeInfo[] = [
  { storedType: 'ORDERED_MATERIAL', apiType: 'ordered_material', sectionKey: 'ordered_materials', canAssignBudgetCategory: true, canContributeSpend: true },
  { storedType: 'USED_MATERIAL', apiType: 'used_material', sectionKey: 'used_materials', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'LEFTOVER_MATERIAL', apiType: 'leftover_material', sectionKey: 'leftovers', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'SUPPLIER_DELIVERY_NOTE', apiType: 'supplier_delivery_note', sectionKey: 'supplier_delivery_notes', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'CUSTOMER_CHANGE', apiType: 'customer_change', sectionKey: 'customer_changes', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'WATCH_OUT', apiType: 'watch_out', sectionKey: 'watch_outs', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'LABOUR', apiType: 'labour', sectionKey: 'labour', canAssignBudgetCategory: true, canContributeSpend: true },
  { storedType: 'GENERAL_NOTE', apiType: 'general_note', sectionKey: 'general_notes', canAssignBudgetCategory: false, canContributeSpend: false },
  { storedType: 'UNCLEAR', apiType: 'unclear', sectionKey: 'unclear_items', canAssignBudgetCategory: false, canContributeSpend: false },
] as const

const BY_STORED = new Map(MEMORY_TYPES.map((t) => [t.storedType, t]))
const BY_API = new Map(MEMORY_TYPES.map((t) => [t.apiType, t]))

// The lower-case memory types a request may confirm/correct/create memory as.
// UNCLEAR is a valid stored type but is never an acceptable target memory type,
// so it is deliberately absent here (matches existing route validation).
export const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set(
  MEMORY_TYPES.filter((t) => t.storedType !== 'UNCLEAR').map((t) => t.apiType),
)

// lower-case API value → stored upper-case value ('ordered_material' → 'ORDERED_MATERIAL')
export function toStoredMemoryType(apiType: string): string | null {
  return BY_API.get(apiType)?.storedType ?? null
}

// stored upper-case value → lower-case API value ('ORDERED_MATERIAL' → 'ordered_material')
export function toApiMemoryType(storedType: string): string | null {
  return BY_STORED.get(storedType)?.apiType ?? null
}

// stored upper-case value → memory-view/review section key
export function sectionKeyForMemoryType(storedType: string): string | null {
  return BY_STORED.get(storedType)?.sectionKey ?? null
}

// lower-case API value → section key (for callers holding request values)
export function sectionKeyForApiMemoryType(apiType: string): string | null {
  return BY_API.get(apiType)?.sectionKey ?? null
}

// True for any known stored upper-case type, including UNCLEAR.
export function isValidMemoryType(storedType: string): boolean {
  return BY_STORED.has(storedType)
}

// Budget categories are meaningful only on bought/ordered materials and labour.
export function isCategoryAssignableMemoryType(storedType: string): boolean {
  return BY_STORED.get(storedType)?.canAssignBudgetCategory ?? false
}

export function isCategoryAssignableApiMemoryType(apiType: string): boolean {
  return BY_API.get(apiType)?.canAssignBudgetCategory ?? false
}

// Only bought/ordered materials and labour can contribute to known spend.
export function isSpendMemoryType(storedType: string): boolean {
  return BY_STORED.get(storedType)?.canContributeSpend ?? false
}
