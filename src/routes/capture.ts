import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { AudioStorageProvider } from '../storage/index.js'
import type { ExtractionProvider } from '../extraction/index.js'
import { triggerFiledExtraction } from '../extraction/worker.js'
import { captureError } from '../services/capture-ownership.js'
import { captureNote, fileNote } from '../services/notes.js'
import {
  getNoteDraft,
  looksRight,
  moveNote,
} from '../services/capture-notes.js'
import {
  capturePhoto,
  getCapturePhotoFile,
  placePhoto,
  uploadCapturePhoto,
} from '../services/capture-photos.js'
import { getCaptureHome, getUnfiled } from '../services/capture-home.js'
import { handleServiceError } from './jobs.js'

function targetJob(body: unknown): string {
  const jobId = (body as { jobId?: unknown } | null)?.jobId
  if (typeof jobId !== 'string' || !jobId.trim())
    throw captureError('INVALID_FIELD', 'jobId is required')
  return jobId
}

function sendCaptureError(error: unknown, reply: FastifyReply) {
  const code = (error as { code?: string } | null)?.code
  if (
    code &&
    [
      'JOB_NOT_FILEABLE',
      'NOTE_ALREADY_FILED',
      'PHOTO_ALREADY_FILED',
      'NOTE_NOT_FILED',
      'PHOTO_NOT_FILED',
      'NOTE_MOVE_BLOCKED',
      'DRAFT_CHANGED',
      'P2025',
      'P2034',
    ].includes(code)
  ) {
    return reply
      .code(409)
      .send(
        ['P2025', 'P2034'].includes(code)
          ? captureError(
              'DRAFT_CHANGED',
              'This item changed. Refresh and try again.',
            )
          : error,
      )
  }
  return handleServiceError(error, reply)
}

const captureRoutes: FastifyPluginAsync<{
  storage: AudioStorageProvider
  extraction: ExtractionProvider
}> = async (app, opts) => {
  app.get('/api/home', (request) => getCaptureHome(request.userId))
  app.get('/api/unfiled', (request) => getUnfiled(request.userId))

  for (const action of ['file', 'move'] as const) {
    app.post<{ Params: { noteId: string } }>(
      `/api/notes/:noteId/${action}`,
      async (request, reply) => {
        try {
          const jobId = targetJob(request.body)
          const place = action === 'file' ? fileNote : moveNote
          const note = await place(request.params.noteId, request.userId, jobId)
          setImmediate(() => {
            triggerFiledExtraction(note.id, opts.extraction).catch((err) =>
              request.log.error({ err }, 'extraction trigger error'),
            )
          })
          return { note: captureNote(note) }
        } catch (err) {
          return sendCaptureError(err, reply)
        }
      },
    )

    app.post<{ Params: { photoId: string } }>(
      `/api/photos/:photoId/${action}`,
      async (request, reply) => {
        try {
          const photo = await placePhoto(
            request.params.photoId,
            request.userId,
            targetJob(request.body),
            action === 'move',
          )
          return { photo: capturePhoto(photo) }
        } catch (err) {
          return sendCaptureError(err, reply)
        }
      },
    )
  }

  app.get<{ Params: { noteId: string } }>(
    '/api/notes/:noteId/draft',
    async (request, reply) => {
      try {
        return await getNoteDraft(request.params.noteId, request.userId)
      } catch (err) {
        return sendCaptureError(err, reply)
      }
    },
  )

  app.post<{ Params: { noteId: string } }>(
    '/api/notes/:noteId/looks-right',
    async (request, reply) => {
      const ids = (request.body as { queueItemIds?: unknown } | null)
        ?.queueItemIds
      if (
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string' || !id.trim())
      ) {
        return reply
          .code(400)
          .send(
            captureError(
              'INVALID_FIELD',
              'queueItemIds must be an array of non-empty ids',
            ),
          )
      }
      try {
        return await looksRight(request.params.noteId, request.userId, [
          ...new Set(ids),
        ])
      } catch (err) {
        return sendCaptureError(err, reply)
      }
    },
  )

  app.post('/api/photos', async (request, reply) => {
    try {
      const fields = new Map<string, string>()
      let bytes: Buffer | undefined
      let mimeType: string | undefined
      for await (const part of request.parts()) {
        if (part.type === 'field')
          fields.set(part.fieldname, String(part.value))
        else if (part.fieldname === 'file' && !bytes) {
          bytes = await part.toBuffer()
          mimeType = part.mimetype
        } else
          for await (const _ of part.file) {
            /* drain ignored file */
          }
      }
      const clientPhotoId = fields.get('clientPhotoId')?.trim()
      if (!clientPhotoId || !bytes?.length || !mimeType)
        throw captureError(
          'MISSING_FIELD',
          'file and clientPhotoId are required',
        )
      const context = fields.get('captureContext')
      if (context !== 'home' && context !== 'job')
        throw captureError(
          'INVALID_FIELD',
          'captureContext must be home or job',
        )
      const result = await uploadCapturePhoto(
        {
          userId: request.userId,
          jobId: fields.get('jobId') || null,
          clientPhotoId,
          captureContext: context === 'home' ? 'HOME' : 'JOB',
          mimeType,
          bytes,
        },
        opts.storage,
      )
      return reply
        .code(result.duplicate ? 200 : 201)
        .send({ photo: capturePhoto(result.photo) })
    } catch (err) {
      return sendCaptureError(err, reply)
    }
  })

  app.get<{ Params: { photoId: string } }>(
    '/api/photos/:photoId/file',
    async (request, reply) => {
      try {
        const { bytes, mimeType } = await getCapturePhotoFile(
          request.params.photoId,
          request.userId,
          opts.storage,
        )
        return reply
          .type(mimeType)
          .header('Cache-Control', 'private, max-age=300')
          .send(bytes)
      } catch (err) {
        return sendCaptureError(err, reply)
      }
    },
  )
}
export default captureRoutes
