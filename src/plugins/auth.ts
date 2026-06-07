import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db/client.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

// Minimal pilot auth: accepts X-Pilot-User-Id header or falls back to the
// seeded pilot user. Replace with proper JWT/session auth before any non-pilot use.
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('userId', '')

  fastify.addHook('preHandler', async (request, reply) => {
    const pilotUserId = process.env.PILOT_USER_ID
    const headerUserId = request.headers['x-pilot-user-id']

    const userId =
      typeof headerUserId === 'string' && headerUserId.length > 0
        ? headerUserId
        : pilotUserId

    if (!userId) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'No user identity provided' })
      return
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'User not found' })
      return
    }

    request.userId = user.id
  })
}

export default fp(authPlugin)
