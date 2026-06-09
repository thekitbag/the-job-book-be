import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db/client.js'
import { createSessionToken } from '../lib/session.js'
import { ErrorCode } from '../types/errors.js'

const COOKIE_NAME = 'pilot_session'
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

// Browsers only delete a cookie if the clearing Set-Cookie uses the same
// Domain/Path/Secure/SameSite attributes that were present when it was set.
function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? ('none' as const) : ('lax' as const),
    domain: isProduction ? (process.env.COOKIE_DOMAIN ?? '.thejobbook.app') : undefined,
    path: '/',
  }
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { passcode?: string } }>('/api/auth/pilot-login', async (request, reply) => {
    const { passcode } = request.body ?? {}

    if (!passcode) {
      return reply.code(400).send({ code: ErrorCode.MISSING_FIELD, message: 'passcode is required' })
    }

    const expectedPasscode = process.env.PILOT_PASSCODE
    if (!expectedPasscode || passcode !== expectedPasscode) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid passcode' })
    }

    const pilotUserId = process.env.PILOT_USER_ID
    if (!pilotUserId) {
      request.log.error('PILOT_USER_ID env var is not set')
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Pilot user not configured' })
    }

    const user = await prisma.user.findUnique({ where: { id: pilotUserId } })
    if (!user) {
      request.log.error({ pilotUserId }, 'Pilot user not found in database')
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Pilot user not found' })
    }

    const secret = process.env.SESSION_COOKIE_SECRET ?? 'dev-secret-change-in-production'
    const token = createSessionToken(user.id, secret)
    const isProduction = process.env.NODE_ENV === 'production'

    reply.setCookie(COOKIE_NAME, token, {
      ...sessionCookieOptions(isProduction),
      maxAge: COOKIE_MAX_AGE,
    })

    return reply.send({ ok: true })
  })

  fastify.post('/api/auth/logout', async (_request, reply) => {
    const isProduction = process.env.NODE_ENV === 'production'
    reply.clearCookie(COOKIE_NAME, sessionCookieOptions(isProduction))
    return reply.send({ ok: true })
  })
}

export default authRoutes
