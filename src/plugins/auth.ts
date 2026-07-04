import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { resolveRequestUser } from '../lib/request-auth.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
    userRole: string
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('userId', '')
  fastify.decorateRequest('userRole', '')

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url === '/health') return
    // Auth endpoints handle their own auth
    if (request.url.startsWith('/api/auth/')) return

    const user = await resolveRequestUser(request)
    if (user) {
      request.userId = user.id
      request.userRole = user.role
      return
    }

    reply.code(401).send({ code: 'UNAUTHORIZED', message: 'No valid session' })
  })
}

export default fp(authPlugin)
