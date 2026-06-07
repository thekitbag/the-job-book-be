import type { FastifyPluginAsync } from 'fastify'
import { listFactsByJob, listFactsByNote } from '../services/facts.js'
import { handleServiceError } from './jobs.js'

const factsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/facts',
    async (request, reply) => {
      try {
        const facts = await listFactsByJob(request.params.jobId, request.userId)
        return reply.send(facts)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )

  fastify.get<{ Params: { jobId: string; noteId: string } }>(
    '/api/jobs/:jobId/notes/:noteId/facts',
    async (request, reply) => {
      try {
        const facts = await listFactsByNote(request.params.jobId, request.params.noteId, request.userId)
        return reply.send(facts)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    },
  )
}

export default factsRoutes
