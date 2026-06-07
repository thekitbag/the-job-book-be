import { FakeTranscriptionProvider } from './fake.js'
import { OpenAITranscriptionProvider } from './openai.js'
import type { TranscriptionProvider } from './types.js'

export function createTranscriptionProvider(): TranscriptionProvider {
  const provider = process.env.TRANSCRIPTION_PROVIDER ?? 'fake'

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when TRANSCRIPTION_PROVIDER=openai')
    return new OpenAITranscriptionProvider(apiKey)
  }

  return new FakeTranscriptionProvider()
}

export type { TranscriptionProvider } from './types.js'
