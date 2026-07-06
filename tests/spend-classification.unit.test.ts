// Table-driven unit tests for the shared known-spend classifier — the single
// rule set behind memory-view costSummary and budget-summary.
import { describe, it, expect } from 'vitest'
import { classifySpend, sumKnownSpend } from '../src/lib/spend-classification.js'
import type { SpendClassifiable } from '../src/lib/spend-classification.js'

function item(overrides: Partial<SpendClassifiable> = {}): SpendClassifiable {
  return {
    id: 'm-1',
    memoryType: 'ORDERED_MATERIAL',
    summary: 'Ordered 12 sheets of plasterboard',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    labourHours: null,
    labourPerson: null,
    labourTask: null,
    costAmount: null,
    costCurrency: 'GBP',
    totalCostAmount: '600',
    unresolvedFlags: [],
    budgetCategoryId: null,
    ...overrides,
  }
}

function labour(overrides: Partial<SpendClassifiable> = {}): SpendClassifiable {
  return item({
    memoryType: 'LABOUR',
    summary: 'Tom did 8 hours on electrics',
    materialName: null,
    quantity: null,
    unit: null,
    labourHours: '8',
    labourPerson: 'Tom',
    labourTask: 'electrics',
    costAmount: '35',
    costQualifier: undefined,
    totalCostAmount: '280',
    ...overrides,
  } as Partial<SpendClassifiable>)
}

describe('classifySpend — inclusion', () => {
  const included: Array<[string, SpendClassifiable]> = [
    ['safe GBP ordered material', item()],
    ['safe GBP labour', labour()],
  ]

  it.each(included)('%s is included', (_name, m) => {
    const c = classifySpend(m)
    expect(c.kind).toBe('included')
    if (c.kind !== 'included') return
    expect(c.row.lineTotalAmount).toBe(m.totalCostAmount)
    expect(c.row.lineTotalCurrency).toBe('GBP')
    expect(c.row.lineTotalLabel).toBe(`£${m.totalCostAmount} total`)
    expect(c.row.memoryItemId).toBe(m.id)
  })

  it('included row carries normalized identity, labour, and category facts', () => {
    const c = classifySpend(labour({ budgetCategoryId: 'cat-labour' }))
    expect(c).toMatchObject({
      kind: 'included',
      row: {
        memoryItemId: 'm-1',
        memoryType: 'LABOUR',
        itemLabel: 'electrics', // labourTask fallback when no materialName
        labourHours: '8',
        labourPerson: 'Tom',
        labourTask: 'electrics',
        budgetCategoryId: 'cat-labour',
      },
    })
  })

  it('itemLabel prefers materialName, then labourTask, then summary, then a generic label', () => {
    const get = (m: SpendClassifiable) => {
      const c = classifySpend(m)
      return c.kind === 'non_spend' ? null : c.row.itemLabel
    }
    expect(get(item())).toBe('plasterboard')
    expect(get(item({ materialName: null, summary: 'Jewson order' }))).toBe('Jewson order')
    expect(get(item({ materialName: '  ', summary: ' \t ' }))).toBe('Bought item')
  })
})

describe('classifySpend — exclusion reasons', () => {
  const cases: Array<[string, SpendClassifiable, string]> = [
    // no cost evidence at all
    ['ordered material with no cost fields', item({ totalCostAmount: null, costAmount: null }), 'no_cost_remembered'],
    ['hours-only labour', labour({ totalCostAmount: null, costAmount: null, costCurrency: null }), 'no_rate_or_cost'],
    // ambiguous / incomplete cost evidence
    ['ordered material with costAmount but no safe total', item({ totalCostAmount: null, costAmount: '5' }), 'cost_worth_checking'],
    ['labour with rate but no derived total', labour({ totalCostAmount: null }), 'cost_worth_checking'],
    ['ordered material with total but missing currency', item({ costCurrency: null }), 'cost_worth_checking'],
    // non-GBP
    ['ordered material with EUR total', item({ costCurrency: 'EUR' }), 'cost_worth_checking'],
    ['labour with EUR total', labour({ costCurrency: 'EUR' }), 'cost_worth_checking'],
    // unresolved flags always exclude, even with a stored GBP total
    ['ordered material with unresolved flags', item({ unresolvedFlags: ['cost_uncertain'] }), 'cost_worth_checking'],
    ['labour with unresolved flags', labour({ unresolvedFlags: ['cost_uncertain'] }), 'cost_worth_checking'],
    // unresolved flags count as evidence worth checking even with no cost fields
    ['flagged material with no cost fields', item({ totalCostAmount: null, costAmount: null, unresolvedFlags: ['material_uncertain'] }), 'cost_worth_checking'],
  ]

  it.each(cases)('%s → %s', (_name, m, reason) => {
    const c = classifySpend(m)
    expect(c.kind).toBe('excluded')
    if (c.kind !== 'excluded') return
    expect(c.row.reason).toBe(reason as never)
    expect(c.row.memoryItemId).toBe(m.id)
    expect(c.row.itemLabel.trim().length).toBeGreaterThan(0)
  })
})

describe('classifySpend — non-spend memory types', () => {
  const types = [
    'USED_MATERIAL',
    'LEFTOVER_MATERIAL',
    'SUPPLIER_DELIVERY_NOTE',
    'CUSTOMER_CHANGE',
    'WATCH_OUT',
    'GENERAL_NOTE',
    'UNCLEAR',
  ]

  it.each(types.map((t) => [t]))('%s never contributes, even with a safe GBP total', (memoryType) => {
    expect(classifySpend(item({ memoryType }))).toEqual({ kind: 'non_spend' })
  })
})

describe('sumKnownSpend', () => {
  it('returns null for an empty list', () => {
    expect(sumKnownSpend([])).toBeNull()
  })

  it('sums strict decimals and rounds to pence', () => {
    expect(sumKnownSpend(['1850', '320'])).toBe('2170')
    expect(sumKnownSpend(['0.1', '0.2'])).toBe('0.3')
  })

  it('ignores non-parseable amounts rather than failing', () => {
    expect(sumKnownSpend(['100', 'about fifty'])).toBe('100')
  })
})
