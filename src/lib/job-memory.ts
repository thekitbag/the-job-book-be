// Shared projection rules. Stored evidence and historical money are never edited.
export const MATERIAL_TYPES = new Set([
  'ORDERED_MATERIAL',
  'USED_MATERIAL',
  'LEFTOVER_MATERIAL',
  'RETURNED_MATERIAL',
])
export const QUEUE_MEMORY_TYPES = new Set([
  ...MATERIAL_TYPES,
  'LABOUR',
  'UNCLEAR',
])

export function stripMoneyPhrase(text: string): string {
  if (!/£|\bquid\b|\bpounds?\b/i.test(text)) return text
  return text
    .replace(
      /(?:\bat\s+|\bfor\s+|[·,]\s*)?£\s*[\d,.]+(?:\s*(?:each|per hour|an hour|total|refund|refunded))?/gi,
      '',
    )
    .replace(
      /(?:\bat\s+|\bfor\s+)?(?:\d[\d,.]*|(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)\s+)+)\s*(?:quid|pounds?)(?:\s*(?:each|total))?/gi,
      '',
    )
    .replace(/£/g, '')
    .replace(/\bquid\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[·,\s]+$/, '')
    .trim()
}

type MemoryFields = {
  memoryType?: string
  factType?: string
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  locationOrUse?: string | null
  labourPerson?: string | null
  labourHours?: string | null
  labourTask?: string | null
  happenedAt?: string | Date | null
}
export const materialAmount = (m: MemoryFields) =>
  [m.quantity, m.unit].filter(Boolean).join(' ') || null

export function memoryLabel(m: MemoryFields): string {
  const type = (m.memoryType ?? m.factType ?? '').toUpperCase()
  const parts =
    type === 'LABOUR'
      ? [
          m.labourPerson,
          m.labourHours ? `${m.labourHours} hours` : null,
          m.labourTask,
          m.happenedAt instanceof Date
            ? m.happenedAt.toISOString().slice(0, 10)
            : m.happenedAt?.slice(0, 10),
        ]
      : [m.materialName, materialAmount(m), m.supplierName, m.locationOrUse]
  return (
    stripMoneyPhrase(parts.filter(Boolean).join(', ')) || 'Needs clarification'
  )
}

// Includes money affordances and summaries as a whole, so no empty money UI
// survives. Used at the builder API boundary; support and inspection bypass it.
export const isMoneyKey = (key: string) =>
  /cost|refund|knownSpend|lineTotal|budget|paid|markPaid|customerTotal|moneyEvent|spend|exclu|labourPersonId|labourPeople|inheritedLabourPerson|unitCost/i.test(
    key,
  )

export function withoutMoney<T>(value: T): T {
  if (typeof value === 'string') return stripMoneyPhrase(value) as T
  if (value == null || typeof value !== 'object' || value instanceof Date)
    return value
  if (Array.isArray(value)) return value.map(withoutMoney) as T
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(obj)) {
    if (!isMoneyKey(key))
      out[key] =
        key.endsWith('Flags') && Array.isArray(v)
          ? v
              .filter(
                (f) =>
                  typeof f !== 'string' || !/cost|budget|paid|refund/i.test(f),
              )
              .map(withoutMoney)
          : withoutMoney(v)
  }
  const type = String(obj.memoryType ?? obj.factType ?? '').toUpperCase()
  if (MATERIAL_TYPES.has(type) || type === 'LABOUR' || type === 'UNCLEAR') {
    if ('summary' in obj) out.summary = memoryLabel(obj as MemoryFields)
  }
  return out as T
}

// Remove ignored fields BEFORE validation too: stale clients may send malformed
// money fields. This intentionally does not coerce or validate those values.
export function ignoreMoneyInput<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !isMoneyKey(key)),
  ) as T
}
