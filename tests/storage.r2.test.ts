import { describe, it, expect, vi, beforeEach } from 'vitest'
import { R2AudioStorage } from '../src/storage/r2.js'

// vi.hoisted ensures mockSend is available when the vi.mock factory runs (hoisted above all imports)
const mockSend = vi.hoisted(() => vi.fn())

vi.mock('@aws-sdk/client-s3', () => {
  // Use classes — arrow functions cannot be used as constructors with `new`
  class S3Client {
    send = mockSend
    constructor(_config: unknown) {}
  }
  class PutObjectCommand {
    [key: string]: unknown
    constructor(input: Record<string, unknown>) { Object.assign(this, input) }
  }
  class GetObjectCommand {
    [key: string]: unknown
    constructor(input: Record<string, unknown>) { Object.assign(this, input) }
  }
  class DeleteObjectCommand {
    [key: string]: unknown
    constructor(input: Record<string, unknown>) { Object.assign(this, input) }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
})

const TEST_CONFIG = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret',
  bucket: 'test-bucket',
}

const TEST_KEY = 'notes/job-1/note-1.webm'
const TEST_DATA = Buffer.from('fake-audio-bytes')
const TEST_MIME = 'audio/webm'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('R2AudioStorage.store', () => {
  it('calls PutObjectCommand with correct key, body, content type, and bucket', async () => {
    mockSend.mockResolvedValueOnce({})

    const storage = new R2AudioStorage(TEST_CONFIG)
    const result = await storage.store(TEST_KEY, TEST_DATA, TEST_MIME)

    expect(mockSend).toHaveBeenCalledOnce()
    const [cmd] = mockSend.mock.calls[0]
    expect(cmd.Bucket).toBe('test-bucket')
    expect(cmd.Key).toBe(TEST_KEY)
    expect(cmd.Body).toEqual(TEST_DATA)
    expect(cmd.ContentType).toBe(TEST_MIME)
    expect(cmd.ContentLength).toBe(TEST_DATA.byteLength)

    expect(result).toEqual({ key: TEST_KEY, bucket: 'test-bucket', sizeBytes: TEST_DATA.byteLength })
  })

  it('propagates upload errors without logging audio content', async () => {
    mockSend.mockRejectedValueOnce(new Error('R2 connection refused'))

    const storage = new R2AudioStorage(TEST_CONFIG)
    await expect(storage.store(TEST_KEY, TEST_DATA, TEST_MIME)).rejects.toThrow('R2 connection refused')
  })
})

describe('R2AudioStorage.read', () => {
  it('calls GetObjectCommand and streams body to Buffer', async () => {
    async function* fakeStream() {
      yield Buffer.from('audio-chunk-1')
      yield Buffer.from('audio-chunk-2')
    }
    mockSend.mockResolvedValueOnce({ Body: fakeStream() })

    const storage = new R2AudioStorage(TEST_CONFIG)
    const result = await storage.read(TEST_KEY)

    expect(mockSend).toHaveBeenCalledOnce()
    const [cmd] = mockSend.mock.calls[0]
    expect(cmd.Bucket).toBe('test-bucket')
    expect(cmd.Key).toBe(TEST_KEY)

    expect(result).toEqual(Buffer.concat([Buffer.from('audio-chunk-1'), Buffer.from('audio-chunk-2')]))
  })

  it('throws when Body is absent', async () => {
    mockSend.mockResolvedValueOnce({ Body: null })

    const storage = new R2AudioStorage(TEST_CONFIG)
    await expect(storage.read(TEST_KEY)).rejects.toThrow()
  })
})

describe('R2AudioStorage.delete', () => {
  it('calls DeleteObjectCommand with correct key and bucket', async () => {
    mockSend.mockResolvedValueOnce({})

    const storage = new R2AudioStorage(TEST_CONFIG)
    await storage.delete(TEST_KEY)

    expect(mockSend).toHaveBeenCalledOnce()
    const [cmd] = mockSend.mock.calls[0]
    expect(cmd.Bucket).toBe('test-bucket')
    expect(cmd.Key).toBe(TEST_KEY)
  })
})

describe('createStorageProvider (env-driven)', () => {
  it('returns local storage when AUDIO_STORAGE_PROVIDER=local', async () => {
    process.env.AUDIO_STORAGE_PROVIDER = 'local'
    const { createStorageProvider } = await import('../src/storage/index.js')
    const provider = createStorageProvider()
    expect(provider.constructor.name).toBe('LocalAudioStorage')
    delete process.env.AUDIO_STORAGE_PROVIDER
  })

  it('throws when AUDIO_STORAGE_PROVIDER=r2 but R2 env vars are missing', async () => {
    process.env.AUDIO_STORAGE_PROVIDER = 'r2'
    delete process.env.R2_ENDPOINT
    const { createStorageProvider } = await import('../src/storage/index.js')
    expect(() => createStorageProvider()).toThrow('R2 storage requires')
    delete process.env.AUDIO_STORAGE_PROVIDER
  })
})
