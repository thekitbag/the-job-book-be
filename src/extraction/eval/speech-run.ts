/**
 * Speech-to-memory credibility harness CLI entry point.
 *
 * This file is CLI-only and calls main() unconditionally.
 * All testable logic lives in speech-evaluate.ts — import from there in tests.
 *
 * Usage:
 *   npm run eval:speech-memory
 *   npm run eval:speech-memory -- --provider openai
 *   npm run eval:speech-memory -- --out reports/extraction-eval/speech-memory.md
 *
 * Default provider is offline-safe fake. OpenAI mode requires OPENAI_API_KEY.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExtractionProvider } from '../types.js'
import { FakeExtractionProvider } from '../fake.js'
import { SPEECH_FIXTURES } from './speech-fixtures.js'
import { runSpeechEvaluation } from './speech-evaluate.js'
import { generateSpeechMarkdownReport } from './speech-report.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const providerIdx = args.indexOf('--provider')
  const providerName = providerIdx !== -1 ? args[providerIdx + 1] : 'fake'

  const outIdx = args.indexOf('--out')
  const outPath =
    outIdx !== -1 ? args[outIdx + 1] : 'reports/extraction-eval/speech-memory.md'

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

  console.log(
    `\nSpeech-memory credibility evaluation — provider: ${providerName}, fixtures: ${SPEECH_FIXTURES.length}`,
  )

  const results = await runSpeechEvaluation(SPEECH_FIXTURES, provider)

  const pass = results.filter((r) => r.base.status === 'pass').length
  const needsReview = results.filter((r) => r.base.status === 'needs_review').length
  const fail = results.filter((r) => r.base.status === 'fail').length
  const safe = results.filter((r) => r.safeOutcome).length
  const unsafe = results.filter((r) => !r.safeOutcome).length

  const report = generateSpeechMarkdownReport(results, {
    providerName,
    providerModel: model,
    schemaVersion,
    timestamp: new Date().toISOString(),
    fixtureSetName: 'speech-memory',
  })

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, report, 'utf-8')

  console.log(`\nAccuracy: ✅ ${pass} pass  ⚠️ ${needsReview} needs_review  ❌ ${fail} fail`)
  console.log(`Safety:   ✅ ${safe} safe  🚨 ${unsafe} unsafe`)
  console.log(`Report written to: ${outPath}\n`)
}

main()
