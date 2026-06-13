import type { FastifyPluginAsync } from 'fastify'
import { getMemoryView } from '../services/memory-view.js'
import { handleServiceError } from './jobs.js'

const memoryViewRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { jobId: string } }>('/api/jobs/:jobId/memory-view', async (request, reply) => {
    try {
      const data = await getMemoryView(request.params.jobId, request.userId)
      return reply.send(data)
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

export default memoryViewRoutes
