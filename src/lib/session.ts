import { createHmac, timingSafeEqual } from 'node:crypto'

interface SessionPayload {
  userId: string
  iat: number
  exp: number
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export function createSessionToken(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: SessionPayload = { userId, iat: now, exp: now + SESSION_TTL_SECONDS }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  return `${encodedPayload}.${sig}`
}

export function verifySessionToken(token: string, secret: string): SessionPayload | null {
  const dot = token.lastIndexOf('.')
  if (dot === -1) return null

  const encodedPayload = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expectedSig = createHmac('sha256', secret).update(encodedPayload).digest('base64url')

  // Constant-time comparison to prevent timing attacks
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'ascii'), Buffer.from(expectedSig, 'ascii'))) return null
  } catch {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as SessionPayload
    if (typeof payload.userId !== 'string' || typeof payload.exp !== 'number') return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
