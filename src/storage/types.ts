export interface StoredObject {
  key: string
  bucket: string
  sizeBytes: number
}

export interface AudioStorageProvider {
  store(key: string, data: Buffer, mimeType: string): Promise<StoredObject>
  read(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}
