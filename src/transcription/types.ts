export interface TranscriptionInput {
  noteId: string
  audioKey: string
  audioBuffer: Buffer
  mimeType: string
}

export interface TranscriptionResult {
  text: string
  language?: string
  confidence?: number
  providerResponseId?: string
}

export interface TranscriptionProvider {
  readonly name: string
  readonly model: string
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
}
