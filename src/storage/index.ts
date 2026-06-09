import { LocalAudioStorage } from './local.js'
import { R2AudioStorage } from './r2.js'
import type { AudioStorageProvider } from './types.js'

export type { AudioStorageProvider, StoredObject } from './types.js'

export function createStorageProvider(): AudioStorageProvider {
  // AUDIO_STORAGE_PROVIDER is the canonical name; STORAGE_MODE is kept for backward compat
  const mode = process.env.AUDIO_STORAGE_PROVIDER ?? process.env.STORAGE_MODE ?? 'local'

  if (mode === 'local') {
    const dir = process.env.LOCAL_AUDIO_DIR ?? process.env.AUDIO_STORE_DIR ?? './audio-store'
    return new LocalAudioStorage(dir)
  }

  if (mode === 'r2') {
    const endpoint = process.env.R2_ENDPOINT
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    const bucket = process.env.R2_BUCKET

    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        'R2 storage requires R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET',
      )
    }

    return new R2AudioStorage({ endpoint, accessKeyId, secretAccessKey, bucket })
  }

  throw new Error(`Unsupported AUDIO_STORAGE_PROVIDER: ${mode}. Supported: local, r2`)
}
