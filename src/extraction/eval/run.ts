/**
 * Extraction evaluation harness CLI entry point.
 *
 * This file is CLI-only and calls main() unconditionally.
 * All testable evaluation logic lives in evaluate.ts — import from there in tests.
 *
 * Usage:
 *   npm run eval:extraction
 *   npm run eval:extraction -- --provider fake
 *   npm run eval:extraction -- --provider openai
 *   npm run eval:extraction -- --out reports/extraction-eval/latest.md
 *
 * Default provider is offline-safe fake. OpenAI mode requires OPENAI_API_KEY
 * and is manually invoked. CI must not require OPENAI_API_KEY.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExtractionProvider } from '../types.js'
import { FakeExtractionProvider } from '../fake.js'
import { GOLDEN_FIXTURES } from './fixtures.js'
import { runEvaluation } from './evaluate.js'
import { generateMarkdownReport } from './report.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const providerIdx = args.indexOf('--provider')
  const providerName = providerIdx !== -1 ? args[providerIdx + 1] : 'fake'

  const outIdx = args.indexOf('--out')
  const outPath = outIdx !== -1 ? args[outIdx + 1] : 'reports/extraction-eval/latest.md'

  let provider: ExtractionProvider
  let model: string
  const schemaVersion = 'v1'

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
  } else {
    const p = new FakeExtractionProvider()
    provider = p
    model = p.model
  }

  console.log(`\nExtraction evaluation — provider: ${providerName}, fixtures: ${GOLDEN_FIXTURES.length}`)

  const results = await runEvaluation(GOLDEN_FIXTURES, provider)

  const pass = results.filter((r) => r.status === 'pass').length
  const needsReview = results.filter((r) => r.status === 'needs_review').length
  const fail = results.filter((r) => r.status === 'fail').length

  const report = generateMarkdownReport(results, {
    providerName,
    providerModel: model,
    schemaVersion,
    timestamp: new Date().toISOString(),
    fixtureSetName: 'extraction-golden',
  })

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, report, 'utf-8')

  console.log(`\nResults: ✅ ${pass} pass  ⚠️ ${needsReview} needs_review  ❌ ${fail} fail`)
  console.log(`Report written to: ${outPath}\n`)
}

main()
