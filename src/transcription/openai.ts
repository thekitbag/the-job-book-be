import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from './types.js'

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai'
  readonly model = 'whisper-1'

  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const form = new FormData()
    const blob = new Blob([input.audioBuffer], { type: input.mimeType })
    form.append('file', blob, 'audio.webm')
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })

    if (!response.ok) {
      const text = await response.text()
      throw { code: 'PROVIDER_HTTP_ERROR', message: `OpenAI API error ${response.status}: ${text}` }
    }

    const data = (await response.json()) as {
      text: string
      language?: string
      id?: string
    }

    return {
      text: data.text,
      language: data.language,
      providerResponseId: data.id,
    }
  }
}
