import type { FastifyPluginAsync } from 'fastify'
import { getBookMoney } from '../services/book-money.js'
import { handleServiceError } from './jobs.js'

const bookMoneyRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/book/money — cross-job Money read model (Book Home summary +
  // overview). Read-only by design: this slice adds no write routes, and
  // opening the page must not create or mutate any record.
  fastify.get('/api/book/money', async (request, reply) => {
    try {
      return reply.send(await getBookMoney(request.userId))
    } catch (err: unknown) {
      return handleServiceError(err, reply)
    }
  })
}

export default bookMoneyRoutes
