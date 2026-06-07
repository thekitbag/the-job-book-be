import { FakeExtractionProvider } from './fake.js'
import { OpenAIExtractionProvider } from './openai.js'
import type { ExtractionProvider } from './types.js'

export function createExtractionProvider(): ExtractionProvider {
  const provider = process.env.EXTRACTION_PROVIDER ?? 'fake'

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when EXTRACTION_PROVIDER=openai')
    return new OpenAIExtractionProvider(apiKey)
  }

  return new FakeExtractionProvider()
}

export type { ExtractionProvider } from './types.js'
