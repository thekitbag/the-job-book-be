import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db/client.js'
import { verifySessionToken } from '../lib/session.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

const COOKIE_NAME = 'pilot_session'

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('userId', '')

  fastify.addHook('preHandler', async (request, reply) => {
    // Auth endpoints handle their own auth
    if (request.url.startsWith('/api/auth/')) return

    const secret = process.env.SESSION_COOKIE_SECRET ?? 'dev-secret-change-in-production'

    // 1. Session cookie — primary auth (dev + production)
    const sessionCookie = request.cookies?.[COOKIE_NAME]
    if (sessionCookie) {
      const payload = verifySessionToken(sessionCookie, secret)
      if (payload) {
        const user = await prisma.user.findUnique({ where: { id: payload.userId } })
        if (user) {
          request.userId = user.id
          return
        }
      }
      // Cookie present but invalid/expired — fall through to header check in dev, or reject in production
      if (process.env.NODE_ENV === 'production') {
        reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid or expired session' })
        return
      }
    }

    // 2. X-Pilot-User-Id header — dev only
    if (process.env.NODE_ENV !== 'production') {
      const headerUserId =
        typeof request.headers['x-pilot-user-id'] === 'string' &&
        request.headers['x-pilot-user-id'].length > 0
          ? request.headers['x-pilot-user-id']
          : process.env.PILOT_USER_ID

      if (headerUserId) {
        const user = await prisma.user.findUnique({ where: { id: headerUserId } })
        if (user) {
          request.userId = user.id
          return
        }
      }
    }

    reply.code(401).send({ code: 'UNAUTHORIZED', message: 'No valid session' })
  })
}

export default fp(authPlugin)
