import type { ReportMeta } from './report.js'
import type { SpeechFixtureComparison } from './speech-compare.js'

export type { ReportMeta }

function statusIcon(s: string): string {
  if (s === 'pass') return '✅'
  if (s === 'needs_review') return '⚠️'
  return '❌'
}

function safeIcon(safe: boolean): string {
  return safe ? '✅ safe' : '🚨 unsafe'
}

function riskLabel(r: string): string {
  if (r === 'high') return '🔴 high'
  if (r === 'medium') return '🟡 medium'
  return '🟢 low'
}

// ── section helpers ───────────────────────────────────────────────────────────

function summaryTable(results: SpeechFixtureComparison[]): string[] {
  const lines: string[] = []
  lines.push('| ID | Title | Domain Terms | Status | Outcome | Risk |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of results) {
    const id = `\`${r.fixture.id}\``
    const terms = r.fixture.domainTerms.join(', ')
    const status = statusIcon(r.base.status) + ' ' + r.base.status
    const outcome = safeIcon(r.safeOutcome)
    const risk = riskLabel(r.credibilityRisk)
    lines.push(`| ${id} | ${r.fixture.title} | ${terms} | ${status} | ${outcome} | ${risk} |`)
  }
  return lines
}

function perFixtureDetail(r: SpeechFixtureComparison): string[] {
  const { fixture, base, safeOutcome, unsafeReasons } = r
  const lines: string[] = []
  const icon = statusIcon(base.status)

  lines.push(`### ${icon} \`${fixture.id}\` — ${fixture.title}`)
  lines.push('')
  lines.push(`**Domain terms:** ${fixture.domainTerms.join(', ')}  `)
  lines.push(`**Credibility risk:** ${riskLabel(fixture.credibilityRisk)}  `)
  lines.push(`**Safe outcome:** ${safeIcon(safeOutcome)}`)
  lines.push('')
  lines.push(`> **Intended:** ${fixture.intendedUtterance}`)
  lines.push(`> **Transcript:** ${fixture.transcriptText}`)
  lines.push('')

  if (base.providerError) {
    lines.push(`**Provider error:** ${base.providerError}`)
    lines.push('')
    return lines
  }

  if (unsafeReasons.length > 0) {
    lines.push('**Unsafe reasons:**')
    for (const reason of unsafeReasons) {
      lines.push(`- 🚨 ${reason}`)
    }
    lines.push('')
  }

  if (base.actual.length > 0) {
    lines.push('<details><summary>Raw actual output</summary>')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(base.actual, null, 2))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  lines.push(`_Notes: ${fixture.notes}_`)
  lines.push('')

  return lines
}

// ── recommendation ────────────────────────────────────────────────────────────

function generateRecommendation(results: SpeechFixtureComparison[]): string[] {
  const unsafeResults = results.filter((r) => !r.safeOutcome)
  const allReasons = unsafeResults.flatMap((r) => r.unsafeReasons)

  if (unsafeResults.length === 0) {
    return [
      '**No glossary needed yet.** All high-credibility-risk fixtures produced safe outcomes with the current provider.',
      '',
      'The extraction system is handling domain term noise acceptably. Monitor for regressions as the prompt evolves.',
    ]
  }

  const lines: string[] = []
  const confidenceViolations = allReasons.filter((r) => r.includes('Confidence too high')).length
  const missingFlags = allReasons.filter((r) => r.includes('uncertainty flag')).length
  const inventedFacts = allReasons.filter((r) => r.includes('Invented high-confidence')).length
  const highRiskUnsafe = results.filter((r) => r.credibilityRisk === 'high' && !r.safeOutcome).length

  if (confidenceViolations > 0) {
    lines.push(`- **Prompt needs domain uncertainty rules.** ${confidenceViolations} fixture(s) returned high confidence on likely mishears. Add explicit prompt guidance: "if the supplier or material name does not match a known trade term, use low or medium confidence and set the appropriate uncertainty flag."`)
  }
  if (missingFlags > 0) {
    lines.push(`- **Schema needs better uncertainty flags.** ${missingFlags} expected risk signal(s) were not returned. Consider whether the current uncertainty flag vocabulary covers the domain mishear cases.`)
  }
  if (inventedFacts > 0) {
    lines.push(`- **Prompt needs stronger hallucination guards.** ${inventedFacts} high-confidence invented fact(s) detected — the provider is filling in information not present in the transcript.`)
  }
  if (highRiskUnsafe >= 3) {
    lines.push(`- **Small pilot glossary likely useful.** ${highRiskUnsafe} high-credibility-risk fixtures failed safely — a small domain glossary of known suppliers (Jewson, Travis Perkins, Screwfix, Toolstation) and common materials (OSB, Celotex, plasterboard) could improve correction confidence and reduce unsafe extraction.`)
  }

  return lines
}

// ── main report ───────────────────────────────────────────────────────────────

export function generateSpeechMarkdownReport(
  results: SpeechFixtureComparison[],
  meta: ReportMeta,
): string {
  const lines: string[] = []

  const pass = results.filter((r) => r.base.status === 'pass').length
  const needsReview = results.filter((r) => r.base.status === 'needs_review').length
  const fail = results.filter((r) => r.base.status === 'fail').length
  const safe = results.filter((r) => r.safeOutcome).length
  const unsafe = results.filter((r) => !r.safeOutcome).length
  const total = results.length

  lines.push('# Speech-to-Memory Credibility Evaluation Report')
  lines.push('')
  lines.push(`**Provider:** ${meta.providerName}  `)
  lines.push(`**Model:** ${meta.providerModel}  `)
  lines.push(`**Schema version:** ${meta.schemaVersion}  `)
  lines.push(`**Fixture set:** ${meta.fixtureSetName}  `)
  lines.push(`**Run at:** ${meta.timestamp}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push('**Extraction accuracy:**')
  lines.push('')
  lines.push('| Status | Count |')
  lines.push('|---|---|')
  lines.push(`| ✅ pass | ${pass} |`)
  lines.push(`| ⚠️ needs_review | ${needsReview} |`)
  lines.push(`| ❌ fail | ${fail} |`)
  lines.push(`| **Total** | **${total}** |`)
  lines.push('')
  lines.push('**Credibility safety:**')
  lines.push('')
  lines.push('| Outcome | Count |')
  lines.push('|---|---|')
  lines.push(`| ✅ safe | ${safe} |`)
  lines.push(`| 🚨 unsafe | ${unsafe} |`)
  lines.push(`| **Total** | **${total}** |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // ── Supplier results ──────────────────────────────────────────────────────

  const supplierResults = results.filter(
    (r) =>
      r.fixture.tags.includes('supplier') &&
      !r.fixture.tags.includes('bad_token') &&
      !r.fixture.tags.includes('mixed'),
  )

  lines.push('## Supplier Term Results')
  lines.push('')
  if (supplierResults.length === 0) {
    lines.push('_No supplier fixtures._')
  } else {
    lines.push(...summaryTable(supplierResults))
  }
  lines.push('')

  // ── Material results ──────────────────────────────────────────────────────

  const materialResults = results.filter(
    (r) =>
      r.fixture.tags.includes('material') &&
      !r.fixture.tags.includes('supplier') &&
      !r.fixture.tags.includes('bad_token') &&
      !r.fixture.tags.includes('mixed'),
  )

  lines.push('## Material Term Results')
  lines.push('')
  if (materialResults.length === 0) {
    lines.push('_No material fixtures._')
  } else {
    lines.push(...summaryTable(materialResults))
  }
  lines.push('')

  // ── Bad-token / mixed results ─────────────────────────────────────────────

  const badTokenResults = results.filter(
    (r) =>
      r.fixture.tags.includes('bad_token') ||
      r.fixture.tags.includes('mixed') ||
      (!r.fixture.tags.includes('supplier') && !r.fixture.tags.includes('material')),
  )

  lines.push('## Bad-Token / Mixed Results')
  lines.push('')
  if (badTokenResults.length === 0) {
    lines.push('_No bad-token or mixed fixtures._')
  } else {
    lines.push(...summaryTable(badTokenResults))
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  // ── High-risk failures ────────────────────────────────────────────────────

  const highRiskFailures = results.filter(
    (r) => r.credibilityRisk === 'high' && !r.safeOutcome,
  )

  lines.push('## High-Risk Failures')
  lines.push('')
  if (highRiskFailures.length === 0) {
    lines.push('_No high-credibility-risk unsafe outcomes. All high-risk fixtures produced safe results._')
    lines.push('')
  } else {
    lines.push(`${highRiskFailures.length} fixture(s) with high credibility risk produced unsafe outcomes:`)
    lines.push('')
    for (const r of highRiskFailures) {
      lines.push(...perFixtureDetail(r))
      lines.push('---')
      lines.push('')
    }
  }

  // ── All fixtures (collapsible) ────────────────────────────────────────────

  lines.push('<details><summary>All fixture details</summary>')
  lines.push('')
  for (const r of results) {
    lines.push(...perFixtureDetail(r))
    lines.push('---')
    lines.push('')
  }
  lines.push('</details>')
  lines.push('')

  // ── Recommendation ────────────────────────────────────────────────────────

  lines.push('## Recommendation')
  lines.push('')
  lines.push('_This recommendation is generated from the fixture results and is a suggestion only — review against the full report before acting._')
  lines.push('')
  const rec = generateRecommendation(results)
  lines.push(...rec)
  lines.push('')

  return lines.join('\n')
}
