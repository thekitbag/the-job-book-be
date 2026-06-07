import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types.js'

export const FAKE_TRANSCRIPT_TEXT = '[fake transcript] Ordered 12 sheets of plasterboard from Jewson.'

export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'fake'
  readonly model = 'fake-v1'

  async transcribe(_input: TranscriptionInput): Promise<TranscriptionResult> {
    return { text: FAKE_TRANSCRIPT_TEXT, language: 'en' }
  }
}

export class FailingTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'fake-failing'
  readonly model = 'fake-v1'

  async transcribe(_input: TranscriptionInput): Promise<TranscriptionResult> {
    throw { code: 'PROVIDER_ERROR', message: 'Simulated transcription provider failure' }
  }
}
