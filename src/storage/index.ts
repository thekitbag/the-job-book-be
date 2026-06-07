import { LocalAudioStorage } from './local.js'
import type { AudioStorageProvider } from './types.js'

export type { AudioStorageProvider, StoredObject } from './types.js'

export function createStorageProvider(): AudioStorageProvider {
  const mode = process.env.STORAGE_MODE ?? 'local'

  if (mode === 'local') {
    const dir = process.env.LOCAL_AUDIO_DIR ?? './audio-store'
    return new LocalAudioStorage(dir)
  }

  // S3-compatible provider placeholder — wire up in a later brief
  throw new Error(`Unsupported STORAGE_MODE: ${mode}. Only 'local' is implemented.`)
}
