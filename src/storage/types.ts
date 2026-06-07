export interface StoredObject {
  key: string
  bucket: string
  sizeBytes: number
}

export interface AudioStorageProvider {
  store(key: string, data: Buffer, mimeType: string): Promise<StoredObject>
  delete(key: string): Promise<void>
}
