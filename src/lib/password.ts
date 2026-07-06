import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

// scrypt parameters (OWASP-recommended interactive-login cost).
// Stored per-hash so they can be raised later without breaking old hashes.
const SCRYPT_N = 2 ** 15 // 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const SALT_LEN = 16

// Format: scrypt$N$r$p$<salt base64url>$<hash base64url>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const hash = (await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  }))
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const salt = Buffer.from(parts[4], 'base64url')
  const expected = Buffer.from(parts[5], 'base64url')

  try {
    const actual = (await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    }))
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ── Password reset tokens ─────────────────────────────────────────────────────
// The raw token goes into the emailed URL; only its SHA-256 hash is stored.

export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashResetToken(token) }
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
