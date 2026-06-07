import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import authPlugin from './plugins/auth.js'
import jobsRoutes from './routes/jobs.js'
import notesRoutes from './routes/notes.js'
import { createStorageProvider } from './storage/index.js'
import type { AudioStorageProvider } from './storage/index.js'
import { MAX_AUDIO_BYTES } from './services/notes.js'

export interface AppOptions {
  storage?: AudioStorageProvider
  maxAudioBytes?: number
}

export function buildApp(opts: AppOptions = {}) {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  })

  const storage = opts.storage ?? createStorageProvider()
  const maxAudioBytes = opts.maxAudioBytes ?? MAX_AUDIO_BYTES

  const rawOrigins = process.env.CORS_ORIGIN ?? 'https://localhost:5173'
  const allowedOrigins = rawOrigins.split(',').map((o) => o.trim())

  fastify.register(cors, {
    origin: (origin, cb) => {
      // No origin header means same-origin or server-to-server — allow.
      // Unrecognised origins: don't throw, just omit CORS headers (browser blocks client-side).
      cb(null, !origin || allowedOrigins.includes(origin))
    },
  })

  fastify.register(multipart, {
    limits: {
      fileSize: maxAudioBytes,
    },
  })

  fastify.register(authPlugin)
  fastify.register(jobsRoutes)
  fastify.register(notesRoutes, { storage })

  // @fastify/multipart v9 calls req.raw.destroy(err) when the file size limit is exceeded,
  // which bypasses route try/catch and lands here. Remap to our stable error code.
  fastify.setErrorHandler((error: Error & { code?: string; statusCode?: number }, request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ code: 'AUDIO_TOO_LARGE', message: 'Audio exceeds max size' })
    }
    request.log.error({ err: error }, error.message)
    return reply.code(error.statusCode ?? 500).send(error)
  })

  fastify.get('/health', async () => ({ status: 'ok' }))

  return fastify
}
