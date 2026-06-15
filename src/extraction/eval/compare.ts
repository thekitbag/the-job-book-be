import type { CandidateFactDraft } from '../types.js'
import type { ExtractionFixture, ExpectedFact } from './fixtures.js'

// ── tolerant string matching ──────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
}

function normalise(s: string | undefined | null): string {
  if (s == null) return ''
  let v = s.toLowerCase().trim()
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    v = v.replace(new RegExp(`\\b${word}\\b`, 'g'), digit)
  }
  return v
}

function fieldsMatch(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined) return true  // not specified in expected → skip
  return normalise(expected) === normalise(actual)
}

// ── comparison types ──────────────────────────────────────────────────────────

export interface FieldDiff {
  field: string
  expected: string | undefined
  actual: string | undefined
}

export type FactMatchStatus = 'matched' | 'field_mismatch' | 'type_mismatch' | 'missing'

export interface FactComparison {
  expectedIndex: number
  actualIndex: number | null
  status: FactMatchStatus
  fieldDiffs: FieldDiff[]
  missingUncertaintyFlags: string[]
}

export type FixtureStatus = 'pass' | 'needs_review' | 'fail'

export interface FixtureComparison {
  fixture: ExtractionFixture
  actual: CandidateFactDraft[]
  status: FixtureStatus
  factComparisons: FactComparison[]
  inventedFacts: CandidateFactDraft[]
  providerError?: string
}

// ── core comparison ───────────────────────────────────────────────────────────

const COMPARED_FIELDS: Array<keyof ExpectedFact & keyof CandidateFactDraft> = [
  'materialName', 'quantity', 'unit', 'supplierName', 'deliveryTiming', 'locationOrUse', 'confidenceLabel',
]

function compareFactToExpected(
  expected: ExpectedFact,
  actual: CandidateFactDraft,
  actualIndex: number,
  expectedIndex: number,
): FactComparison {
  const fieldDiffs: FieldDiff[] = []

  for (const field of COMPARED_FIELDS) {
    const exp = expected[field] as string | undefined
    const act = actual[field] as string | undefined
    if (!fieldsMatch(exp, act)) {
      fieldDiffs.push({ field, expected: exp, actual: act })
    }
  }

  const missingUncertaintyFlags = (expected.uncertaintyFlags ?? []).filter(
    (f) => !(actual.uncertaintyFlags ?? []).includes(f),
  )

  const status: FactMatchStatus =
    fieldDiffs.length === 0 && missingUncertaintyFlags.length === 0 ? 'matched' : 'field_mismatch'

  return { expectedIndex, actualIndex, status, fieldDiffs, missingUncertaintyFlags }
}

export function compareFixture(
  fixture: ExtractionFixture,
  actual: CandidateFactDraft[],
  providerError?: string,
): FixtureComparison {
  if (providerError) {
    return {
      fixture, actual, status: 'fail',
      factComparisons: fixture.expected.map((_, i) => ({
        expectedIndex: i, actualIndex: null, status: 'missing', fieldDiffs: [], missingUncertaintyFlags: [],
      })),
      inventedFacts: [],
      providerError,
    }
  }

  const matchedActualIndices = new Set<number>()
  const factComparisons: FactComparison[] = []

  for (let ei = 0; ei < fixture.expected.length; ei++) {
    const exp = fixture.expected[ei]

    // Find first unmatched actual fact with the right factType
    const ai = actual.findIndex(
      (a, i) => !matchedActualIndices.has(i) && a.factType === exp.factType,
    )

    if (ai === -1) {
      // No actual fact of this type — check if there's a type mismatch or just missing
      const anyUnmatched = actual.findIndex((_, i) => !matchedActualIndices.has(i))
      if (anyUnmatched !== -1) {
        matchedActualIndices.add(anyUnmatched)
        factComparisons.push({
          expectedIndex: ei,
          actualIndex: anyUnmatched,
          status: 'type_mismatch',
          fieldDiffs: [{ field: 'factType', expected: exp.factType, actual: actual[anyUnmatched].factType }],
          missingUncertaintyFlags: [],
        })
      } else {
        factComparisons.push({
          expectedIndex: ei, actualIndex: null, status: 'missing', fieldDiffs: [], missingUncertaintyFlags: [],
        })
      }
    } else {
      matchedActualIndices.add(ai)
      factComparisons.push(compareFactToExpected(exp, actual[ai], ai, ei))
    }
  }

  const inventedFacts = actual.filter((_, i) => !matchedActualIndices.has(i))

  // Score
  const hasMissing = factComparisons.some((c) => c.status === 'missing')
  const hasTypeMismatch = factComparisons.some((c) => c.status === 'type_mismatch')
  const hasInvented = inventedFacts.length > 0

  const hasMissingFlags = factComparisons.some((c) => c.missingUncertaintyFlags.length > 0)
  const hasFieldMismatch = factComparisons.some((c) => c.status === 'field_mismatch')

  let status: FixtureStatus
  if (hasMissing || hasTypeMismatch || hasInvented) {
    status = 'fail'
  } else if (hasMissingFlags || hasFieldMismatch) {
    status = 'needs_review'
  } else {
    status = 'pass'
  }

  return { fixture, actual, status, factComparisons, inventedFacts }
}
