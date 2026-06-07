import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioStorageProvider, StoredObject } from './types.js'

const LOCAL_BUCKET = 'local'

export class LocalAudioStorage implements AudioStorageProvider {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async store(key: string, data: Buffer, _mimeType: string): Promise<StoredObject> {
    const filePath = join(this.baseDir, key)
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, data)
    return { key, bucket: LOCAL_BUCKET, sizeBytes: data.byteLength }
  }

  async read(key: string): Promise<Buffer> {
    const filePath = join(this.baseDir, key)
    return readFile(filePath)
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.baseDir, key)
    await unlink(filePath)
  }
}
