import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { ErrorCode } from '../types/errors.js'
import { createSessionToken } from '../lib/session.js'
import { getSessionCookieSecret } from '../config/production.js'
import {
  SESSION_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
  sessionCookieOptions,
} from '../lib/cookies.js'
import { resolveRequestUser } from '../lib/request-auth.js'
import {
  signup,
  login,
  requestPasswordReset,
  confirmPasswordReset,
  getSafeUser,
} from '../services/auth.js'
import type { SafeUser } from '../services/auth.js'
import type { EmailProvider } from '../email/index.js'
import { createEmailProvider } from '../email/index.js'
import { isApiError } from './jobs.js'

const AUTH_STATUS_MAP: Record<string, number> = {
  [ErrorCode.MISSING_FIELD]: 400,
  [ErrorCode.INVALID_FIELD]: 400,
  [ErrorCode.EMAIL_IN_USE]: 409,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.RESET_TOKEN_INVALID]: 400,
}

function handleAuthError(err: unknown, reply: FastifyReply) {
  if (isApiError(err)) {
    return reply.code(AUTH_STATUS_MAP[err.code] ?? 400).send(err)
  }
  throw err
}

export interface AuthRoutesOptions {
  email?: EmailProvider
}

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, opts) => {
  const emailProvider = opts.email ?? createEmailProvider()
  const isProduction = () => process.env.NODE_ENV === 'production'

  function setSession(reply: FastifyReply, userId: string) {
    const token = createSessionToken(userId, getSessionCookieSecret(process.env))
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      ...sessionCookieOptions(isProduction()),
      maxAge: SESSION_COOKIE_MAX_AGE,
    })
    // Retire the pre-account-auth cookie so it cannot linger alongside the new one.
    reply.clearCookie(LEGACY_SESSION_COOKIE_NAME, sessionCookieOptions(isProduction()))
  }

  fastify.post<{ Body: { email?: unknown; password?: unknown; name?: unknown } }>(
    '/api/auth/signup',
    async (request, reply) => {
      try {
        const body = request.body ?? {}
        const user: SafeUser = await signup(body.email, body.password, body.name)
        setSession(reply, user.id)
        return reply.code(201).send({ user })
      } catch (err: unknown) {
        return handleAuthError(err, reply)
      }
    },
  )

  fastify.post<{ Body: { email?: unknown; password?: unknown } }>(
    '/api/auth/login',
    async (request, reply) => {
      try {
        const body = request.body ?? {}
        const user = await login(body.email, body.password)
        setSession(reply, user.id)
        return reply.send({ user })
      } catch (err: unknown) {
        return handleAuthError(err, reply)
      }
    },
  )

  fastify.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(isProduction()))
    reply.clearCookie(LEGACY_SESSION_COOKIE_NAME, sessionCookieOptions(isProduction()))
    return reply.send({ ok: true })
  })

  fastify.get('/api/auth/me', async (request, reply) => {
    const authed = await resolveRequestUser(request)
    if (!authed) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'No valid session' })
    }
    const user = await getSafeUser(authed.id)
    if (!user) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'No valid session' })
    }
    return reply.send({ user })
  })

  fastify.post<{ Body: { email?: unknown } }>(
    '/api/auth/password-reset/request',
    async (request, reply) => {
      const body = request.body ?? {}
      try {
        await requestPasswordReset(body.email, emailProvider)
      } catch (err: unknown) {
        // Email delivery failure must not reveal whether the account exists.
        request.log.error({ err }, 'password reset email failed')
      }
      return reply.send({ ok: true })
    },
  )

  fastify.post<{ Body: { token?: unknown; password?: unknown } }>(
    '/api/auth/password-reset/confirm',
    async (request, reply) => {
      try {
        const body = request.body ?? {}
        const user = await confirmPasswordReset(body.token, body.password)
        // Documented behaviour: successful reset logs the user in.
        setSession(reply, user.id)
        return reply.send({ user })
      } catch (err: unknown) {
        return handleAuthError(err, reply)
      }
    },
  )
}

export default authRoutes
