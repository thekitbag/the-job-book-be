import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import authPlugin from './plugins/auth.js'
import jobsRoutes from './routes/jobs.js'
import notesRoutes from './routes/notes.js'
import authRoutes from './routes/auth.js'
import { createStorageProvider } from './storage/index.js'
import type { AudioStorageProvider } from './storage/index.js'
import { createTranscriptionProvider } from './transcription/index.js'
import type { TranscriptionProvider } from './transcription/index.js'
import { createExtractionProvider } from './extraction/index.js'
import type { ExtractionProvider } from './extraction/index.js'
import factsRoutes from './routes/facts.js'
import reviewRoutes from './routes/review.js'
import tidyUpRoutes from './routes/tidy-up.js'
import { MAX_AUDIO_BYTES } from './services/notes.js'

export interface AppOptions {
  storage?: AudioStorageProvider
  transcription?: TranscriptionProvider
  extraction?: ExtractionProvider
  maxAudioBytes?: number
}

export function buildApp(opts: AppOptions = {}) {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  })

  const storage = opts.storage ?? createStorageProvider()
  const transcription = opts.transcription ?? createTranscriptionProvider()
  const extraction = opts.extraction ?? createExtractionProvider()
  const maxAudioBytes = opts.maxAudioBytes ?? MAX_AUDIO_BYTES

  fastify.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // No origin header: same-origin or server-to-server — allow
      if (!origin) { cb(null, true); return }
      // Read at request time so tests can change env between requests
      // FRONTEND_ORIGIN is the canonical production env var; CORS_ORIGIN kept for local dev compat
      const rawOrigins = process.env.FRONTEND_ORIGIN ?? process.env.CORS_ORIGIN ?? 'https://localhost:5173'
      const allowedOrigins = rawOrigins.split(',').map((o) => o.trim())
      cb(null, allowedOrigins.includes(origin))
    },
  })

  fastify.register(cookie)

  fastify.register(multipart, {
    limits: {
      fileSize: maxAudioBytes,
    },
  })

  // Auth routes bypass the auth plugin (login/logout handle their own flow)
  fastify.register(authRoutes)

  fastify.register(authPlugin)
  fastify.register(jobsRoutes)
  fastify.register(notesRoutes, { storage, transcription, extraction })
  fastify.register(factsRoutes)
  fastify.register(reviewRoutes)
  fastify.register(tidyUpRoutes)

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
