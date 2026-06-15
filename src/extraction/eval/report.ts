import type { FixtureComparison } from './compare.js'

export interface ReportMeta {
  providerName: string
  providerModel: string
  schemaVersion: string
  timestamp: string
  fixtureSetName: string
}

function statusIcon(s: string): string {
  if (s === 'pass') return '✅'
  if (s === 'needs_review') return '⚠️'
  return '❌'
}

function fmtField(v: string | undefined): string {
  return v == null ? '_(not set)_' : `\`${v}\``
}

export function generateMarkdownReport(
  results: FixtureComparison[],
  meta: ReportMeta,
): string {
  const pass = results.filter((r) => r.status === 'pass').length
  const needsReview = results.filter((r) => r.status === 'needs_review').length
  const fail = results.filter((r) => r.status === 'fail').length
  const total = results.length

  const lines: string[] = []

  lines.push('# Extraction Evaluation Report')
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
  lines.push(`| Status | Count |`)
  lines.push(`|---|---|`)
  lines.push(`| ✅ pass | ${pass} |`)
  lines.push(`| ⚠️ needs_review | ${needsReview} |`)
  lines.push(`| ❌ fail | ${fail} |`)
  lines.push(`| **Total** | **${total}** |`)
  lines.push('')

  // ── per-fixture ────────────────────────────────────────────────────────────

  lines.push('---')
  lines.push('')
  lines.push('## Per-fixture Results')
  lines.push('')

  for (const result of results) {
    const { fixture, actual, status, factComparisons, inventedFacts, providerError } = result
    const icon = statusIcon(status)

    lines.push(`### ${icon} \`${fixture.id}\` — ${fixture.title}`)
    lines.push('')
    lines.push(`**Tags:** ${fixture.tags.join(', ')}`)
    lines.push('')
    lines.push(`> ${fixture.transcriptText}`)
    lines.push('')

    if (providerError) {
      lines.push(`**Provider error:** ${providerError}`)
      lines.push('')
      lines.push('---')
      lines.push('')
      continue
    }

    lines.push(`**Expected facts:** ${fixture.expected.length}  **Actual facts:** ${actual.length}`)
    lines.push('')

    if (factComparisons.length === 0 && fixture.expected.length === 0) {
      if (actual.length === 0) {
        lines.push('_No facts expected or returned — correct._')
      } else {
        lines.push('_No facts expected but extraction returned facts:_')
        for (const a of actual) {
          lines.push(`- **INVENTED** \`${a.factType}\` — ${a.summary}`)
        }
      }
      lines.push('')
      lines.push('---')
      lines.push('')
      continue
    }

    // Fact comparisons
    for (const fc of factComparisons) {
      const exp = fixture.expected[fc.expectedIndex]
      lines.push(`**Expected fact ${fc.expectedIndex + 1}:** \`${exp.factType}\``)

      if (fc.status === 'missing') {
        lines.push('- ❌ **MISSING** — no actual fact of this type was returned')
      } else if (fc.status === 'type_mismatch') {
        const act = actual[fc.actualIndex!]
        lines.push(`- ❌ **TYPE MISMATCH** — expected \`${exp.factType}\` got \`${act.factType}\``)
      } else {
        lines.push(`- ${fc.status === 'matched' ? '✅ matched' : '⚠️ partial match'}`)
        for (const diff of fc.fieldDiffs) {
          lines.push(`  - \`${diff.field}\`: expected ${fmtField(diff.expected)} got ${fmtField(diff.actual)}`)
        }
        for (const flag of fc.missingUncertaintyFlags) {
          lines.push(`  - \`uncertaintyFlags\`: missing expected flag \`${flag}\``)
        }
      }
      lines.push('')
    }

    if (inventedFacts.length > 0) {
      lines.push('**Invented facts (no expected match):**')
      for (const inv of inventedFacts) {
        lines.push(`- ❌ \`${inv.factType}\` — ${inv.summary}`)
      }
      lines.push('')
    }

    if (actual.length > 0) {
      lines.push('<details><summary>Raw actual output</summary>')
      lines.push('')
      lines.push('```json')
      lines.push(JSON.stringify(actual, null, 2))
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }

    lines.push(`_Notes: ${fixture.notes}_`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // ── recurring failure patterns ─────────────────────────────────────────────

  lines.push('## Recurring Failure Patterns')
  lines.push('')

  const missingCount = results.reduce(
    (n, r) => n + r.factComparisons.filter((c) => c.status === 'missing').length, 0,
  )
  const typeMismatchCount = results.reduce(
    (n, r) => n + r.factComparisons.filter((c) => c.status === 'type_mismatch').length, 0,
  )
  const inventedCount = results.reduce((n, r) => n + r.inventedFacts.length, 0)
  const missingFlagCount = results.reduce(
    (n, r) => n + r.factComparisons.reduce((m, c) => m + c.missingUncertaintyFlags.length, 0), 0,
  )
  const fieldMismatchCount = results.reduce(
    (n, r) => n + r.factComparisons.filter((c) => c.status === 'field_mismatch').length, 0,
  )

  lines.push(`| Pattern | Count |`)
  lines.push(`|---|---|`)
  lines.push(`| Missing expected facts | ${missingCount} |`)
  lines.push(`| Fact type mismatches | ${typeMismatchCount} |`)
  lines.push(`| Invented facts | ${inventedCount} |`)
  lines.push(`| Missing uncertainty flags | ${missingFlagCount} |`)
  lines.push(`| Field value mismatches | ${fieldMismatchCount} |`)
  lines.push('')

  return lines.join('\n')
}
