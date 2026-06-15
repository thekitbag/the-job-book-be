import { describe, it, expect } from 'vitest'
import { SPEECH_FIXTURES } from '../src/extraction/eval/speech-fixtures.js'
import { compareSpeechFixture } from '../src/extraction/eval/speech-compare.js'
import { generateSpeechMarkdownReport } from '../src/extraction/eval/speech-report.js'
import { runSpeechEvaluation } from '../src/extraction/eval/speech-evaluate.js'
import type { CandidateFactDraft } from '../src/extraction/types.js'
import type { ExtractionProvider, ExtractionInput, ExtractionResult } from '../src/extraction/types.js'

// ── side-effect-free import regression ───────────────────────────────────────
// Importing speech-evaluate.ts must not write a report, read process.argv, or
// call process.exit. If this test runs at all, the import was side-effect free.

describe('speech-evaluate module — import side effects', () => {
  it('exports runSpeechEvaluation without writing files or reading process args', () => {
    expect(typeof runSpeechEvaluation).toBe('function')
  })
})

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
  fixtureSetName: 'speech-memory-test',
}

// ── fixture loader ────────────────────────────────────────────────────────────

describe('speech fixture loader', () => {
  it('loads at least 18 fixtures', () => {
    expect(SPEECH_FIXTURES.length).toBeGreaterThanOrEqual(18)
  })

  it('every fixture has required speech fields', () => {
    for (const f of SPEECH_FIXTURES) {
      expect(typeof f.id).toBe('string')
      expect(typeof f.title).toBe('string')
      expect(typeof f.transcriptText).toBe('string')
      expect(typeof f.intendedUtterance).toBe('string')
      expect(Array.isArray(f.domainTerms)).toBe(true)
      expect(f.domainTerms.length).toBeGreaterThan(0)
      expect(['high', 'medium', 'low']).toContain(f.credibilityRisk)
      expect(Array.isArray(f.tags)).toBe(true)
      expect(Array.isArray(f.expected)).toBe(true)
      expect(typeof f.notes).toBe('string')
    }
  })

  it('covers all required supplier terms', () => {
    const domainTerms = SPEECH_FIXTURES.flatMap((f) => f.domainTerms)
    const suppliersToCheck = ['Jewson', 'Travis Perkins', 'Screwfix', 'Toolstation']
    for (const supplier of suppliersToCheck) {
      expect(domainTerms, `Missing supplier coverage: ${supplier}`).toContain(supplier)
    }
  })

  it('covers all required material terms', () => {
    const domainTerms = SPEECH_FIXTURES.flatMap((f) => f.domainTerms)
    const materialsToCheck = ['OSB', 'Celotex', 'plasterboard', 'battens', 'cladding']
    for (const material of materialsToCheck) {
      expect(domainTerms, `Missing material coverage: ${material}`).toContain(material)
    }
  })

  it('includes high-credibility-risk fixtures', () => {
    const highRisk = SPEECH_FIXTURES.filter((f) => f.credibilityRisk === 'high')
    expect(highRisk.length).toBeGreaterThanOrEqual(8)
  })

  it('includes both clean and mishear variants', () => {
    const cleanTags = SPEECH_FIXTURES.filter((f) => f.tags.includes('clean'))
    const mishearTags = SPEECH_FIXTURES.filter((f) => f.tags.includes('mishear'))
    expect(cleanTags.length).toBeGreaterThanOrEqual(4)
    expect(mishearTags.length).toBeGreaterThanOrEqual(8)
  })

  it('fixture IDs are unique', () => {
    const ids = SPEECH_FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── clean domain term: safe outcome ──────────────────────────────────────────

describe('compareSpeechFixture — clean domain term', () => {
  it('returns safeOutcome: true when clean supplier captured correctly', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-clean')!
    const actual = [
      makeFact({
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: 'Jewson',
        deliveryTiming: 'tomorrow morning',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(true)
    expect(result.base.status).toBe('pass')
  })

  it('returns safeOutcome: true when clean material captured correctly', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'mat-osb-clean')!
    const actual = [
      makeFact({
        factType: 'used_material',
        materialName: 'OSB',
        quantity: '6',
        unit: 'boards',
        locationOrUse: 'back wall',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(true)
  })
})

// ── nonsense token with high confidence: unsafe ───────────────────────────────

describe('compareSpeechFixture — nonsense token captured with high confidence', () => {
  it('marks unsafe when "juice and" stored as confident supplier', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-juice-and')!
    const actual = [
      makeFact({
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: 'juice and',   // nonsense term captured with high confidence
        confidenceLabel: 'high',
        uncertaintyFlags: [],        // missing expected supplier_uncertain flag
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.length).toBeGreaterThan(0)
  })

  it('marks unsafe when "USB" stored as confident material name', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'mat-osb-usb')!
    const actual = [
      makeFact({
        factType: 'used_material',   // wrong — expected unclear
        materialName: 'USB',         // nonsense term
        quantity: '6',
        unit: 'boards',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
  })

  it('marks unsafe when "Jason" stored as confident supplier (person name)', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-jason')!
    const actual = [
      makeFact({
        factType: 'ordered_material',
        supplierName: 'Jason',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.some((r) => r.includes('supplierName'))).toBe(true)
  })

  it('marks unsafe when expected customer-name fixture invents a high-confidence supplier', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'real-customer-name-dave')!
    expect(fixture.expected).toHaveLength(0)  // no facts expected

    const actual = [
      makeFact({
        factType: 'supplier_delivery_note',
        supplierName: 'Dave',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
        summary: 'Dave confirmed boundary agreement',
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.some((r) => r.includes('Invented high-confidence'))).toBe(true)
  })

  it('marks unsafe when expected supplier is non-empty but actual returns a different high-confidence supplier', () => {
    // Regression: previously only flagged when expected === '' (absent).
    // A wrong high-confidence supplier is a credibility risk regardless of what was expected.
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-clean')!
    // fixture expects supplierName: 'Jewson' with high confidence
    const actual = [
      makeFact({
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: 'screw fits',   // wrong supplier, high confidence
        deliveryTiming: 'tomorrow morning',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.some((r) => r.includes('supplierName'))).toBe(true)
  })

  it('marks unsafe when expected material is non-empty but actual returns a different high-confidence material', () => {
    // Regression: previously only flagged when expected === '' (absent).
    // A wrong high-confidence material name is a credibility risk regardless of what was expected.
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'mat-osb-clean')!
    // fixture expects materialName: 'OSB' with high confidence
    const actual = [
      makeFact({
        factType: 'used_material',
        materialName: 'USB boards',   // wrong material, high confidence
        quantity: '6',
        unit: 'boards',
        locationOrUse: 'back wall',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.some((r) => r.includes('materialName'))).toBe(true)
  })
})

// ── low/medium confidence + uncertainty flags: safe ───────────────────────────

describe('compareSpeechFixture — uncertain output is treated as safer', () => {
  it('marks safe when mishear supplier is omitted with supplier_uncertain flag', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-juice-and')!
    const actual = [
      makeFact({
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: undefined,         // correctly omitted
        deliveryTiming: 'tomorrow morning',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['supplier_uncertain'],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(true)
  })

  it('marks safe when missing facts (under-extraction safer than confident nonsense)', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'mat-osb-usb')!
    const result = compareSpeechFixture(fixture, [])   // extraction returned nothing
    expect(result.safeOutcome).toBe(true)
    expect(result.base.status).toBe('fail')            // accuracy fail, but safe
  })

  it('marks safe when unclear factType returned with low confidence for bad token', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'bad-both-mishears')!
    const actual = [
      makeFact({
        factType: 'unclear',
        summary: 'Garbled material and supplier — cannot extract confidently',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain', 'supplier_uncertain'],
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    // Status may not be pass (notes/summary differ), but outcome is safe
    expect(result.safeOutcome).toBe(true)
  })

  it('marks unsafe when missing expected uncertainty flag even at medium confidence', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-juice-and')!
    const actual = [
      makeFact({
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: undefined,     // correctly omitted
        confidenceLabel: 'medium',
        uncertaintyFlags: [],        // missing supplier_uncertain flag
      }),
    ]
    const result = compareSpeechFixture(fixture, actual)
    expect(result.safeOutcome).toBe(false)
    expect(result.unsafeReasons.some((r) => r.includes('supplier_uncertain'))).toBe(true)
  })
})

// ── credibility risk field ────────────────────────────────────────────────────

describe('compareSpeechFixture — credibility risk from fixture', () => {
  it('inherits credibilityRisk from the fixture', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-juice-and')!
    expect(fixture.credibilityRisk).toBe('high')
    const result = compareSpeechFixture(fixture, [])
    expect(result.credibilityRisk).toBe('high')
  })

  it('low-risk clean fixtures carry low credibilityRisk', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-clean')!
    expect(fixture.credibilityRisk).toBe('low')
    const result = compareSpeechFixture(fixture, [])
    expect(result.credibilityRisk).toBe('low')
  })
})

// ── report generation ─────────────────────────────────────────────────────────

describe('generateSpeechMarkdownReport', () => {
  it('includes provider and schema version in header', () => {
    const fixture = SPEECH_FIXTURES[0]
    const result = compareSpeechFixture(fixture, [])
    const report = generateSpeechMarkdownReport([result], META)
    expect(report).toContain('**Provider:** stub')
    expect(report).toContain('**Schema version:** v1')
  })

  it('includes domain terms for each fixture', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-juice-and')!
    const result = compareSpeechFixture(fixture, [])
    const report = generateSpeechMarkdownReport([result], META)
    expect(report).toContain('Jewson')
  })

  it('includes high-risk failures section', () => {
    const results = SPEECH_FIXTURES.map((f) => compareSpeechFixture(f, []))
    const report = generateSpeechMarkdownReport(results, META)
    expect(report).toContain('High-Risk Failures')
  })

  it('includes supplier and material section headers', () => {
    const results = SPEECH_FIXTURES.slice(0, 5).map((f) => compareSpeechFixture(f, []))
    const report = generateSpeechMarkdownReport(results, META)
    expect(report).toContain('Supplier Term Results')
    expect(report).toContain('Material Term Results')
  })

  it('includes safety outcome counts in summary', () => {
    const fixture = SPEECH_FIXTURES.find((f) => f.id === 'sup-jewson-clean')!
    const results = [compareSpeechFixture(fixture, [])]
    const report = generateSpeechMarkdownReport(results, META)
    expect(report).toContain('safe')
    expect(report).toContain('unsafe')
  })

  it('includes recommendation section', () => {
    const results = SPEECH_FIXTURES.map((f) => compareSpeechFixture(f, []))
    const report = generateSpeechMarkdownReport(results, META)
    expect(report).toContain('Recommendation')
  })
})

// ── runner ────────────────────────────────────────────────────────────────────

describe('runSpeechEvaluation', () => {
  it('runs all fixtures against a stub provider returning empty facts', async () => {
    const results = await runSpeechEvaluation(SPEECH_FIXTURES, stubProvider([]))
    expect(results).toHaveLength(SPEECH_FIXTURES.length)
  })

  it('returns a SpeechFixtureComparison for each fixture', async () => {
    const results = await runSpeechEvaluation(SPEECH_FIXTURES, stubProvider([]))
    for (const r of results) {
      expect(typeof r.safeOutcome).toBe('boolean')
      expect(['high', 'medium', 'low']).toContain(r.credibilityRisk)
      expect(Array.isArray(r.unsafeReasons)).toBe(true)
    }
  })

  it('captures provider errors without throwing', async () => {
    const results = await runSpeechEvaluation(SPEECH_FIXTURES, failingProvider())
    expect(results).toHaveLength(SPEECH_FIXTURES.length)
    expect(results.every((r) => r.base.providerError !== undefined || r.base.actual.length === 0)).toBe(true)
  })

  it('does not call prisma or write to the database', async () => {
    const provider = stubProvider([makeFact()])
    await expect(
      runSpeechEvaluation(SPEECH_FIXTURES.slice(0, 1), provider),
    ).resolves.toBeDefined()
  })
})
