import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import { hashPassword, verifyPassword, generateResetToken, hashResetToken } from '../lib/password.js'
import type { EmailProvider } from '../email/index.js'

const MIN_PASSWORD_LEN = 8
const MAX_PASSWORD_LEN = 200
const MAX_EMAIL_LEN = 254
const MAX_NAME_LEN = 80
const DEFAULT_RESET_TTL_MINUTES = 60

// Deliberately loose: real validation is the reset email round-trip.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SafeUser {
  id: string
  email: string
  name: string
  role: string
}

function toSafeUser(user: { id: string; email: string; name: string; role: string }): SafeUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw { code: ErrorCode.MISSING_FIELD, message: 'email is required' }
  const normalized = email.trim().toLowerCase()
  if (!normalized) throw { code: ErrorCode.MISSING_FIELD, message: 'email is required' }
  if (normalized.length > MAX_EMAIL_LEN || !EMAIL_SHAPE.test(normalized)) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'email must be a valid email address' }
  }
  return normalized
}

function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'password is required' }
  }
  if (password.length < MIN_PASSWORD_LEN) {
    throw { code: ErrorCode.INVALID_FIELD, message: `password must be at least ${MIN_PASSWORD_LEN} characters` }
  }
  if (password.length > MAX_PASSWORD_LEN) {
    throw { code: ErrorCode.INVALID_FIELD, message: `password must be ${MAX_PASSWORD_LEN} characters or fewer` }
  }
  return password
}

export async function signup(emailInput: unknown, passwordInput: unknown, nameInput: unknown): Promise<SafeUser> {
  const email = normalizeEmail(emailInput)
  const password = validatePassword(passwordInput)

  let name = 'Builder'
  if (nameInput !== undefined && nameInput !== null) {
    if (typeof nameInput !== 'string') throw { code: ErrorCode.INVALID_FIELD, message: 'name must be a string' }
    const trimmed = nameInput.trim()
    if (trimmed.length > MAX_NAME_LEN) {
      throw { code: ErrorCode.INVALID_FIELD, message: `name must be ${MAX_NAME_LEN} characters or fewer` }
    }
    if (trimmed) name = trimmed
  }

  const passwordHash = await hashPassword(password)

  try {
    const user = await prisma.user.create({
      data: { email, name, passwordHash },
    })
    return toSafeUser(user)
  } catch (err: unknown) {
    // Unique-constraint race on email — same outcome as a pre-check, but safe
    // under concurrent duplicate signups.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw { code: ErrorCode.EMAIL_IN_USE, message: 'An account with this email already exists' }
    }
    throw err
  }
}

const GENERIC_LOGIN_ERROR = { code: ErrorCode.INVALID_CREDENTIALS, message: 'Incorrect email or password' }

export async function login(emailInput: unknown, passwordInput: unknown): Promise<SafeUser> {
  let email: string
  try {
    email = normalizeEmail(emailInput)
  } catch {
    throw GENERIC_LOGIN_ERROR
  }
  if (typeof passwordInput !== 'string' || passwordInput.length === 0) throw GENERIC_LOGIN_ERROR

  const user = await prisma.user.findUnique({ where: { email } })
  // Same generic error whether the email is unknown, the user has no password
  // set yet, or the password is wrong — no account enumeration via login.
  if (!user || !user.passwordHash) throw GENERIC_LOGIN_ERROR

  const ok = await verifyPassword(passwordInput, user.passwordHash)
  if (!ok) throw GENERIC_LOGIN_ERROR

  return toSafeUser(user)
}

export function getResetTokenTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RESET_TOKEN_TTL_MINUTES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESET_TTL_MINUTES
}

export function buildResetUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.PASSWORD_RESET_URL_BASE ??
    `${env.FRONTEND_ORIGIN ?? env.CORS_ORIGIN ?? 'https://localhost:5173'}/reset-password`
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}token=${token}`
}

// Always resolves without revealing whether the email exists.
export async function requestPasswordReset(emailInput: unknown, emailProvider: EmailProvider): Promise<void> {
  let email: string
  try {
    email = normalizeEmail(emailInput)
  } catch {
    return // invalid/missing email — same silent success, no enumeration
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return

  const { token, tokenHash } = generateResetToken()
  const expiresAt = new Date(Date.now() + getResetTokenTtlMinutes() * 60 * 1000)

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  })

  await emailProvider.sendPasswordReset({ to: user.email, resetUrl: buildResetUrl(token) })
}

// Consumes a valid token, sets the new password, and invalidates all other
// outstanding reset tokens for the user. Returns the user so the route can
// create a session (documented behaviour: confirm logs the user in).
export async function confirmPasswordReset(tokenInput: unknown, passwordInput: unknown): Promise<SafeUser> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) {
    throw { code: ErrorCode.MISSING_FIELD, message: 'token is required' }
  }
  const password = validatePassword(passwordInput)
  const tokenHash = hashResetToken(tokenInput)
  const passwordHash = await hashPassword(password)

  const user = await prisma.$transaction(async (tx) => {
    // Atomic single-use claim: only one concurrent confirm can flip usedAt.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw { code: ErrorCode.RESET_TOKEN_INVALID, message: 'Reset link is invalid or has expired' }
    }

    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash }, include: { user: true } })
    if (!row) throw { code: ErrorCode.RESET_TOKEN_INVALID, message: 'Reset link is invalid or has expired' }

    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } })

    // Invalidate any other outstanding reset tokens for this user.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: new Date() },
    })

    return row.user
  })

  return toSafeUser(user)
}

export async function getSafeUser(userId: string): Promise<SafeUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  return user ? toSafeUser(user) : null
}
