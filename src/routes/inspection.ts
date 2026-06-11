import type { FastifyPluginAsync } from 'fastify'
import { getJobInspection } from '../services/inspection.js'
import { handleServiceError } from './jobs.js'

const inspectionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { jobId: string } }>(
    '/api/internal/pilot/jobs/:jobId/inspection',
    async (request, reply) => {
      const expectedKey = process.env.INTERNAL_INSPECTION_KEY
      const providedKey = request.headers['x-internal-inspection-key']
      const keyStr = Array.isArray(providedKey) ? providedKey[0] : providedKey

      if (!expectedKey) {
        if (process.env.NODE_ENV === 'production') {
          return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Inspection not available' })
        }
        // dev/test: allow without env var set
      } else if (keyStr !== expectedKey) {
        return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid inspection key' })
      }

      try {
        const data = await getJobInspection(request.params.jobId, request.userId)
        return reply.send(data)
      } catch (err: unknown) {
        return handleServiceError(err, reply)
      }
    }
  )
}

export default inspectionRoutes
