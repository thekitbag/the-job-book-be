/**
 * Extraction evaluation harness CLI
 *
 * Usage:
 *   npm run eval:extraction
 *   npm run eval:extraction -- --provider fake
 *   npm run eval:extraction -- --provider openai
 *   npm run eval:extraction -- --out reports/extraction-eval/latest.md
 *
 * CI/tests use --provider fake (offline, no OPENAI_API_KEY required).
 * OpenAI mode requires OPENAI_API_KEY in env and is manually invoked.
 *
 * This file is a CLI entry point. All testable logic is in compare.ts / report.ts.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExtractionProvider } from '../types.js'
import { FakeExtractionProvider } from '../fake.js'
import { GOLDEN_FIXTURES } from './fixtures.js'
import { compareFixture } from './compare.js'
import type { FixtureComparison } from './compare.js'
import { generateMarkdownReport } from './report.js'

export async function runEvaluation(
  fixtures: typeof GOLDEN_FIXTURES,
  provider: ExtractionProvider,
): Promise<FixtureComparison[]> {
  const results: FixtureComparison[] = []

  for (const fixture of fixtures) {
    const input = {
      transcriptId: `eval-tx-${fixture.id}`,
      noteId: `eval-note-${fixture.id}`,
      jobId: `eval-job-${fixture.id}`,
      transcriptText: fixture.transcriptText,
      jobContext: fixture.jobContext,
    }

    let actual: import('../types.js').CandidateFactDraft[] = []
    let providerError: string | undefined
    try {
      const result = await provider.extractFacts(input)
      actual = result.facts
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err)
    }

    results.push(compareFixture(fixture, actual, providerError))
  }

  return results
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const providerIdx = args.indexOf('--provider')
  const providerName = providerIdx !== -1 ? args[providerIdx + 1] : 'fake'

  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 ? args[outIdx + 1] : 'reports/extraction-eval/latest.md'

  let provider: ExtractionProvider
  let model: string
  let schemaVersion: string

  if (providerName === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('Error: OPENAI_API_KEY is not set')
      process.exit(1)
    }
    const { OpenAIExtractionProvider } = await import('../openai.js')
    const p = new OpenAIExtractionProvider(apiKey)
    provider = p
    model = p.model
    schemaVersion = 'v1'
  } else {
    const p = new FakeExtractionProvider()
    provider = p
    model = p.model
    schemaVersion = 'v1'
  }

  console.log(`\nExtraction evaluation — provider: ${providerName}, fixtures: ${GOLDEN_FIXTURES.length}`)

  const results = await runEvaluation(GOLDEN_FIXTURES, provider)

  const pass = results.filter((r) => r.status === 'pass').length
  const needsReview = results.filter((r) => r.status === 'needs_review').length
  const fail = results.filter((r) => r.status === 'fail').length

  const meta = {
    providerName,
    providerModel: model,
    schemaVersion,
    timestamp: new Date().toISOString(),
    fixtureSetName: 'extraction-golden',
  }

  const report = generateMarkdownReport(results, meta)

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, report, 'utf-8')

  console.log(`\nResults: ✅ ${pass} pass  ⚠️ ${needsReview} needs_review  ❌ ${fail} fail`)
  console.log(`Report written to: ${outPath}\n`)
}

main()
