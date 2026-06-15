import type { ExtractionProvider } from '../types.js'
import type { CandidateFactDraft } from '../types.js'
import type { ExtractionFixture } from './fixtures.js'
import { compareFixture } from './compare.js'
import type { FixtureComparison } from './compare.js'

export type { FixtureComparison }

export async function runEvaluation(
  fixtures: ExtractionFixture[],
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

    let actual: CandidateFactDraft[] = []
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
