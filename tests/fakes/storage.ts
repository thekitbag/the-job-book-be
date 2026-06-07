import type { AudioStorageProvider, StoredObject } from '../../src/storage/types.js'

export class FakeAudioStorage implements AudioStorageProvider {
  public stored = new Map<string, { data: Buffer; mimeType: string }>()

  async store(key: string, data: Buffer, mimeType: string): Promise<StoredObject> {
    this.stored.set(key, { data, mimeType })
    return { key, bucket: 'fake', sizeBytes: data.byteLength }
  }

  async delete(key: string): Promise<void> {
    this.stored.delete(key)
  }

  clear() {
    this.stored.clear()
  }
}
