import type { CandidateFactDraft } from '../types.js'
import type { FixtureComparison } from './compare.js'
import { compareFixture } from './compare.js'
import type { SpeechFixture, CredibilityRisk } from './speech-fixtures.js'

export type { CredibilityRisk }

export interface SpeechFixtureComparison {
  base: FixtureComparison
  fixture: SpeechFixture
  safeOutcome: boolean
  credibilityRisk: CredibilityRisk
  unsafeReasons: string[]
}

// ── safety analysis ───────────────────────────────────────────────────────────

function computeSafeOutcome(
  base: FixtureComparison,
): { safe: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (base.status === 'pass') return { safe: true, reasons: [] }

  for (const fc of base.factComparisons) {
    // Missing expected uncertainty flag = provider missed a risk signal
    for (const flag of fc.missingUncertaintyFlags) {
      reasons.push(`Expected uncertainty flag '${flag}' was missing`)
    }

    if (fc.actualIndex === null) {
      // Missing fact = under-extraction. Better than confident nonsense — still safe.
      continue
    }

    const act = base.actual[fc.actualIndex]
    const exp = base.fixture.expected[fc.expectedIndex]
    if (!act || !exp) continue

    // Confidence too high: expected low/medium but provider returned high
    if (exp.confidenceLabel && exp.confidenceLabel !== 'high' && act.confidenceLabel === 'high') {
      reasons.push(`Confidence too high: expected '${exp.confidenceLabel}' but got 'high'`)
    }

    // Supplier/material expected to be absent (empty string '') but set with high confidence
    for (const diff of fc.fieldDiffs) {
      if (
        (diff.field === 'supplierName' || diff.field === 'materialName') &&
        diff.expected === '' &&
        diff.actual &&
        diff.actual.length > 0 &&
        act.confidenceLabel === 'high'
      ) {
        reasons.push(`Nonsense ${diff.field} captured with high confidence: "${diff.actual}"`)
      }
    }

    // Expected 'unclear' but provider returned a confident fact of a different type
    if (exp.factType === 'unclear' && fc.status === 'type_mismatch' && act.confidenceLabel === 'high') {
      reasons.push(`Classified as confident '${act.factType}' when 'unclear' was expected`)
    }
  }

  // Invented facts with high confidence are unsafe regardless of expected set
  for (const inv of base.inventedFacts) {
    if (inv.confidenceLabel === 'high') {
      const summary = inv.summary?.slice(0, 60) ?? ''
      reasons.push(`Invented high-confidence ${inv.factType}: ${summary}`)
    }
  }

  return { safe: reasons.length === 0, reasons }
}

// ── public API ────────────────────────────────────────────────────────────────

export function compareSpeechFixture(
  fixture: SpeechFixture,
  actual: CandidateFactDraft[],
  providerError?: string,
): SpeechFixtureComparison {
  const base = compareFixture(fixture, actual, providerError)
  const { safe, reasons } = computeSafeOutcome(base)

  return {
    base,
    fixture,
    safeOutcome: safe,
    credibilityRisk: fixture.credibilityRisk,
    unsafeReasons: reasons,
  }
}
