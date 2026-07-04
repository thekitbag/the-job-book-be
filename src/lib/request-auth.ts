import type { FastifyRequest } from 'fastify'
import { prisma } from '../db/client.js'
import { verifySessionToken } from './session.js'
import { getSessionCookieSecret } from '../config/production.js'
import { SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME } from './cookies.js'

export interface AuthenticatedUser {
  id: string
  role: string
}

// Resolves the authenticated user for a request, or null.
// Order:
//   1. session cookie (new name, then legacy pilot cookie — same token format)
//   2. dev/test only: X-Pilot-User-Id header or PILOT_USER_ID env
// Production never falls through past the cookie: if a cookie is present but
// invalid, or no cookie is present, the result is null.
export async function resolveRequestUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
  const secret = getSessionCookieSecret(process.env)
  const isProduction = process.env.NODE_ENV === 'production'

  const sessionCookie =
    request.cookies?.[SESSION_COOKIE_NAME] ?? request.cookies?.[LEGACY_SESSION_COOKIE_NAME]

  if (sessionCookie) {
    const payload = verifySessionToken(sessionCookie, secret)
    if (payload) {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, role: true },
      })
      if (user) return { id: user.id, role: user.role }
    }
    if (isProduction) return null
  }

  if (!isProduction) {
    const headerUserId =
      typeof request.headers['x-pilot-user-id'] === 'string' && request.headers['x-pilot-user-id'].length > 0
        ? request.headers['x-pilot-user-id']
        : process.env.PILOT_USER_ID

    if (headerUserId) {
      const user = await prisma.user.findUnique({
        where: { id: headerUserId },
        select: { id: true, role: true },
      })
      if (user) return { id: user.id, role: user.role }
    }
  }

  return null
}
