import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { AudioStorageProvider, StoredObject } from './types.js'

export interface R2Config {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export class R2AudioStorage implements AudioStorageProvider {
  private client: S3Client
  private bucket: string

  constructor(config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
    this.bucket = config.bucket
  }

  async store(key: string, data: Buffer, mimeType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: mimeType,
        ContentLength: data.byteLength,
      }),
    )
    return { key, bucket: this.bucket, sizeBytes: data.byteLength }
  }

  async read(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )

    if (!response.Body) {
      throw new Error(`R2 object not found or empty: ${key}`)
    }

    const chunks: Uint8Array[] = []
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    )
  }
}
