import type { FastifyPluginAsync } from 'fastify'
import { getJobLog } from '../services/job-log.js'
import { handleServiceError } from './jobs.js'
const jobLogRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/log',
    async (request, reply) => {
      try {
        return reply.send(await getJobLog(request.params.jobId, request.userId))
      } catch (err) {
        return handleServiceError(err, reply)
      }
    },
  )
}
export default jobLogRoutes
