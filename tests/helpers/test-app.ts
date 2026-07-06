import { buildApp } from '../../src/app.js'
import { FakeAudioStorage } from '../fakes/storage.js'
import { FakeTranscriptionProvider } from '../../src/transcription/fake.js'
import { FakeExtractionProvider } from '../../src/extraction/fake.js'

// Standard test app: all providers faked, no real storage/API calls.
export function buildTestApp() {
  return buildApp({
    storage: new FakeAudioStorage(),
    transcription: new FakeTranscriptionProvider(),
    extraction: new FakeExtractionProvider(),
  })
}
