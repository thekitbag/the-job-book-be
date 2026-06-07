import type { FastifyPluginAsync } from 'fastify'
import { uploadNote, listNotes, getNote, getTranscript } from '../services/notes.js'
import type { AudioStorageProvider } from '../storage/index.js'
import type { TranscriptionProvider } from '../transcription/index.js'
import { runTranscription } from '../transcription/worker.js'
import type { ExtractionProvider } from '../extraction/index.js'
import { handleServiceError } from './jobs.js'

interface NotesRouteOptions {
  storage: AudioStorageProvider
  transcription: TranscriptionProvider
  extraction: ExtractionProvider
}

const notesRoutes: FastifyPluginAsync<NotesRouteOptions> = async (fastify, opts) => {
  const { storage, transcription, extraction } = opts

  fastify.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/notes',
    async (request, reply) => {
      const { jobId } = request.params

      try {
        const parts = request.parts()

        let clientNoteId: string | undefined
        let capturedAt: Date | undefined
        let durationMs: number | undefined
        let mimeType: string | undefined
        let audioBuffer: Buffer | undefined

        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'clientNoteId') clientNoteId = part.value as string
            else if (part.fieldname === 'capturedAt') capturedAt = new Date(part.value as string)
            else if (part.fieldname === 'durationMs') durationMs = Number(part.value)
            else if (part.fieldname === 'mimeType') mimeType = part.value as string
          } else if (part.type === 'file' && part.fieldname === 'audio') {
            const chunks: Buffer[] = []
            for await (const chunk of part.file) {
              chunks.push(chunk)
            }
            audioBuffer = Buffer.concat(chunks)
            // Derive mimeType from file part if not provided as a field
            if (!mimeType && part.mimetype) mimeType = part.mimetype
          }
        }

        if (!clientNoteId) {
          return reply.code(400).send({ code: 'MISSING_FIELD', message: 'clientNoteId is required' })
        }
        if (!capturedAt) {
          return reply.code(400).send({ code: 'MISSING_FIELD', message: 'capturedAt is required' })
        }
        if (!mimeType) {
          return reply.code(400).send({ code: 'MISSING_FIELD', message: 'mimeType is required' })
        }
        if (!audioBuffer || audioBuffer.byteLength === 0) {
          return reply.code(400).send({ code: 'MISSING_FIELD', message: 'audio file is required' })
        }

        const result = await uploadNote(
          { jobId, userId: request.userId, clientNoteId, capturedAt, durationMs, mimeType, audioBuffer },
          storage,
        )

        if (!result.isDuplicate) {
          setImmediate(() => {
            runTranscription(result.noteId, transcription, storage, extraction).catch((err) => {
              request.log.error({ err }, 'transcription worker error')
            })
          })
        }

        const statusCode = result.isDuplicate ? 200 : 201
        return reply.code(statusCode).send({
          noteId: result.noteId,
          clientNoteId: result.clientNoteId,
          status: result.status,
          isDuplicate: result.isDuplicate,
        })
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/notes',
    async (request, reply) => {
      try {
        const notes = await listNotes(request.params.jobId, request.userId)
        return reply.send(notes)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string; noteId: string } }>(
    '/api/jobs/:jobId/notes/:noteId',
    async (request, reply) => {
      try {
        const note = await getNote(request.params.jobId, request.params.noteId, request.userId)
        return reply.send(note)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string; noteId: string } }>(
    '/api/jobs/:jobId/notes/:noteId/transcript',
    async (request, reply) => {
      try {
        const result = await getTranscript(request.params.jobId, request.params.noteId, request.userId)
        return reply.send(result)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default notesRoutes
