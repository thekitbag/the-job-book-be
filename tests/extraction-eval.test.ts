import { describe, it, expect } from 'vitest'
import { GOLDEN_FIXTURES } from '../src/extraction/eval/fixtures.js'
import { compareFixture } from '../src/extraction/eval/compare.js'
import { generateMarkdownReport } from '../src/extraction/eval/report.js'
import { runEvaluation } from '../src/extraction/eval/run.js'
import type { CandidateFactDraft } from '../src/extraction/types.js'
import type { ExtractionProvider, ExtractionInput, ExtractionResult } from '../src/extraction/types.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFact(overrides?: Partial<CandidateFactDraft>): CandidateFactDraft {
  return {
    factType: 'ordered_material',
    summary: 'Test fact',
    confidenceLabel: 'high',
    confidenceReason: 'test',
    uncertaintyFlags: [],
    ...overrides,
  }
}

function stubProvider(facts: CandidateFactDraft[]): ExtractionProvider {
  return {
    name: 'stub',
    model: 'stub-v1',
    async extractFacts(_input: ExtractionInput): Promise<ExtractionResult> {
      return { facts, schemaVersion: 'v1' }
    },
  }
}

function failingProvider(): ExtractionProvider {
  return {
    name: 'stub-failing',
    model: 'stub-v1',
    async extractFacts(_input: ExtractionInput): Promise<ExtractionResult> {
      throw new Error('Provider unavailable')
    },
  }
}

const META = {
  providerName: 'stub',
  providerModel: 'stub-v1',
  schemaVersion: 'v1',
  timestamp: '2026-06-15T10:00:00.000Z',
  fixtureSetName: 'test',
}

// ── fixture loader ────────────────────────────────────────────────────────────

describe('fixture loader', () => {
  it('loads at least 20 fixtures', () => {
    expect(GOLDEN_FIXTURES.length).toBeGreaterThanOrEqual(20)
  })

  it('every fixture has required fields', () => {
    for (const f of GOLDEN_FIXTURES) {
      expect(typeof f.id).toBe('string')
      expect(typeof f.title).toBe('string')
      expect(typeof f.transcriptText).toBe('string')
      expect(Array.isArray(f.tags)).toBe(true)
      expect(Array.isArray(f.expected)).toBe(true)
      expect(typeof f.notes).toBe('string')
    }
  })

  it('covers all required categories', () => {
    const tags = new Set(GOLDEN_FIXTURES.flatMap((f) => f.tags))
    for (const required of [
      'ordered_material', 'used_material', 'leftover_material',
      'supplier_delivery_note', 'customer_change', 'watch_out',
      'unclear', 'mixed', 'contradiction', 'workshop',
    ]) {
      expect(tags.has(required), `Missing category: ${required}`).toBe(true)
    }
  })

  it('fixture IDs are unique', () => {
    const ids = GOLDEN_FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── compareFixture — missing facts ───────────────────────────────────────────

describe('compareFixture — missing expected facts', () => {
  it('marks status fail when expected fact is not returned', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    const result = compareFixture(fixture, [])

    expect(result.status).toBe('fail')
    expect(result.factComparisons.some((c) => c.status === 'missing')).toBe(true)
  })

  it('reports missing for each unmatched expected fact', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'mixed-001')!
    // Mixed fixture expects 3 facts; return nothing
    const result = compareFixture(fixture, [])

    const missing = result.factComparisons.filter((c) => c.status === 'missing')
    expect(missing.length).toBe(fixture.expected.length)
  })
})

// ── compareFixture — invented facts ──────────────────────────────────────────

describe('compareFixture — invented facts', () => {
  it('detects invented fact when expected is empty but actual has facts', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'unclear-003')!
    expect(fixture.expected).toHaveLength(0)

    const actual = [makeFact({ factType: 'ordered_material', summary: 'Invented' })]
    const result = compareFixture(fixture, actual)

    expect(result.status).toBe('fail')
    expect(result.inventedFacts).toHaveLength(1)
  })

  it('reports invented facts as unmatched actual facts', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    const actual = [
      makeFact({ factType: 'ordered_material', materialName: 'plasterboard', quantity: '12', unit: 'sheets', supplierName: 'Jewson', deliveryTiming: 'tomorrow morning', confidenceLabel: 'high' }),
      makeFact({ factType: 'used_material', summary: 'Invented used material' }),
    ]
    const result = compareFixture(fixture, actual)

    expect(result.inventedFacts).toHaveLength(1)
    expect(result.inventedFacts[0].factType).toBe('used_material')
  })
})

// ── compareFixture — type mismatch ────────────────────────────────────────────

describe('compareFixture — fact-type mismatch', () => {
  it('detects type mismatch when actual factType differs from expected', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'supplier-001')!
    const actual = [makeFact({ factType: 'ordered_material', supplierName: 'Jewson' })]
    const result = compareFixture(fixture, actual)

    expect(result.status).toBe('fail')
    expect(result.factComparisons.some((c) => c.status === 'type_mismatch')).toBe(true)
  })

  it('includes expected and actual factType in the diff', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'watchout-001')!
    const actual = [makeFact({ factType: 'unclear' })]
    const result = compareFixture(fixture, actual)

    const mismatch = result.factComparisons.find((c) => c.status === 'type_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch!.fieldDiffs[0].expected).toBe('watch_out')
    expect(mismatch!.fieldDiffs[0].actual).toBe('unclear')
  })
})

// ── compareFixture — uncertainty flags ───────────────────────────────────────

describe('compareFixture — missing uncertainty flags', () => {
  it('detects missing expected uncertainty flag', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'leftover-002')!
    // Return fact with correct type but missing the approximate_quantity flag
    const actual = [makeFact({
      factType: 'leftover_material',
      materialName: 'cement',
      confidenceLabel: 'low',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)

    expect(result.status).not.toBe('pass')
    const fc = result.factComparisons[0]
    expect(fc.missingUncertaintyFlags).toContain('approximate_quantity')
  })

  it('passes when all expected uncertainty flags are present', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    // Expected has uncertaintyFlags: [] so any actual flags are fine
    const actual = [makeFact({
      factType: 'ordered_material',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
      supplierName: 'Jewson',
      deliveryTiming: 'tomorrow morning',
      confidenceLabel: 'high',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)

    expect(result.factComparisons[0].missingUncertaintyFlags).toHaveLength(0)
  })
})

// ── compareFixture — field matching ──────────────────────────────────────────

describe('compareFixture — tolerant field matching', () => {
  it('matches number words to digits (twelve → 12)', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    const actual = [makeFact({
      factType: 'ordered_material',
      materialName: 'plasterboard',
      quantity: 'twelve',  // number word instead of digit
      unit: 'sheets',
      supplierName: 'Jewson',
      deliveryTiming: 'tomorrow morning',
      confidenceLabel: 'high',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)
    const fc = result.factComparisons[0]
    expect(fc.fieldDiffs.find((d) => d.field === 'quantity')).toBeUndefined()
  })

  it('is case-insensitive for field values', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    const actual = [makeFact({
      factType: 'ordered_material',
      materialName: 'PLASTERBOARD',
      quantity: '12',
      unit: 'SHEETS',
      supplierName: 'JEWSON',
      deliveryTiming: 'Tomorrow Morning',
      confidenceLabel: 'high',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)
    const diffs = result.factComparisons[0].fieldDiffs
    expect(diffs).toHaveLength(0)
  })
})

// ── compareFixture — pass / needs_review / fail scoring ──────────────────────

describe('compareFixture — status scoring', () => {
  it('returns pass when all expected fields match', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'used-001')!
    const actual = [makeFact({
      factType: 'used_material',
      materialName: 'OSB boards',
      quantity: '6',
      unit: 'boards',
      locationOrUse: 'back wall',
      confidenceLabel: 'high',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)
    expect(result.status).toBe('pass')
  })

  it('returns needs_review when field mismatches exist but no missing/type/invented', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'used-002')!
    const actual = [makeFact({
      factType: 'used_material',
      materialName: 'breather membrane',
      quantity: '1',  // rounded — should be "one and a bit"
      unit: 'rolls',
      locationOrUse: 'side elevation',
      confidenceLabel: 'medium',
      uncertaintyFlags: ['approximate_quantity'],
    })]
    const result = compareFixture(fixture, actual)
    expect(result.status).toBe('needs_review')
  })

  it('returns pass for unclear-003 (expect empty, actual empty)', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'unclear-003')!
    expect(fixture.expected).toHaveLength(0)
    const result = compareFixture(fixture, [])
    expect(result.status).toBe('pass')
  })

  it('returns fail on provider error', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    const result = compareFixture(fixture, [], 'Provider unavailable')
    expect(result.status).toBe('fail')
    expect(result.providerError).toBe('Provider unavailable')
  })
})

// ── report generation ─────────────────────────────────────────────────────────

describe('generateMarkdownReport', () => {
  it('includes provider and schema version in header', () => {
    const fixture = GOLDEN_FIXTURES[0]
    const result = compareFixture(fixture, [])
    const report = generateMarkdownReport([result], META)
    expect(report).toContain('**Provider:** stub')
    expect(report).toContain('**Schema version:** v1')
  })

  it('includes per-fixture sections with fixture ID', () => {
    const result = compareFixture(GOLDEN_FIXTURES[0], [])
    const report = generateMarkdownReport([result], META)
    expect(report).toContain(GOLDEN_FIXTURES[0].id)
  })

  it('shows differences in per-fixture section', () => {
    const fixture = GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!
    // Return wrong supplier
    const actual = [makeFact({
      factType: 'ordered_material',
      materialName: 'plasterboard',
      quantity: '12',
      unit: 'sheets',
      supplierName: 'Travis Perkins',  // wrong
      deliveryTiming: 'tomorrow morning',
      confidenceLabel: 'high',
      uncertaintyFlags: [],
    })]
    const result = compareFixture(fixture, actual)
    const report = generateMarkdownReport([result], META)
    expect(report).toContain('supplierName')
    expect(report).toContain('Travis Perkins')
  })

  it('includes summary table with pass/needs_review/fail counts', () => {
    const results = GOLDEN_FIXTURES.slice(0, 3).map((f) => compareFixture(f, []))
    const report = generateMarkdownReport(results, META)
    expect(report).toContain('pass')
    expect(report).toContain('needs_review')
    expect(report).toContain('fail')
  })

  it('includes recurring failure patterns section', () => {
    const results = GOLDEN_FIXTURES.slice(0, 5).map((f) => compareFixture(f, []))
    const report = generateMarkdownReport(results, META)
    expect(report).toContain('Recurring Failure Patterns')
  })
})

// ── runner against stub provider ──────────────────────────────────────────────

describe('runEvaluation', () => {
  it('runs all fixtures against a stub provider returning empty facts', async () => {
    const provider = stubProvider([])
    const results = await runEvaluation(GOLDEN_FIXTURES, provider)
    expect(results).toHaveLength(GOLDEN_FIXTURES.length)
  })

  it('captures provider errors without throwing', async () => {
    const results = await runEvaluation(GOLDEN_FIXTURES, failingProvider())
    expect(results.every((r) => r.providerError !== undefined || r.actual.length === 0)).toBe(true)
    expect(results.every((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'needs_review')).toBe(true)
  })

  it('records failing status for all fixtures when provider always fails', async () => {
    const results = await runEvaluation(
      [GOLDEN_FIXTURES.find((f) => f.id === 'ordered-001')!],
      failingProvider(),
    )
    expect(results[0].status).toBe('fail')
    expect(results[0].providerError).toBeTruthy()
  })

  it('returns pass for empty-expect fixtures when stub returns empty', async () => {
    const emptyExpectFixtures = GOLDEN_FIXTURES.filter((f) => f.expected.length === 0)
    expect(emptyExpectFixtures.length).toBeGreaterThan(0)

    const results = await runEvaluation(emptyExpectFixtures, stubProvider([]))
    expect(results.every((r) => r.status === 'pass')).toBe(true)
  })

  it('does not call prisma or write to the database', async () => {
    // runEvaluation only calls provider.extractFacts — no DB dependency
    // If this test runs without a DB connection, it proves no DB calls happen.
    const provider = stubProvider([makeFact()])
    await expect(runEvaluation(GOLDEN_FIXTURES.slice(0, 1), provider)).resolves.toBeDefined()
  })
})
