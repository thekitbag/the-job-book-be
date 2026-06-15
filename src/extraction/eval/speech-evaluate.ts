import type { ExtractionProvider, CandidateFactDraft } from '../types.js'
import type { SpeechFixture } from './speech-fixtures.js'
import { compareSpeechFixture } from './speech-compare.js'
import type { SpeechFixtureComparison } from './speech-compare.js'

export type { SpeechFixtureComparison }

export async function runSpeechEvaluation(
  fixtures: SpeechFixture[],
  provider: ExtractionProvider,
): Promise<SpeechFixtureComparison[]> {
  const results: SpeechFixtureComparison[] = []

  for (const fixture of fixtures) {
    const input = {
      transcriptId: `speech-eval-${fixture.id}`,
      noteId: `speech-note-${fixture.id}`,
      jobId: `speech-job-${fixture.id}`,
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

    results.push(compareSpeechFixture(fixture, actual, providerError))
  }

  return results
}
