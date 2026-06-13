const DEV_SESSION_SECRET = 'dev-secret-change-in-production'
const MIN_SESSION_SECRET_LEN = 32
const MIN_PASSCODE_LEN = 12
const MIN_INSPECTION_KEY_LEN = 24

const WEAK_PASSCODES = new Set([
  'change-me', 'changeme', 'password', 'admin', 'test', 'passcode', 'pilot', '123456',
])

// ── Session secret helper ─────────────────────────────────────────────────────

export function getSessionCookieSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_COOKIE_SECRET
  if (env.NODE_ENV === 'production') {
    if (!secret || secret === DEV_SESSION_SECRET || secret.length < MIN_SESSION_SECRET_LEN) {
      throw new Error('SESSION_COOKIE_SECRET is missing or invalid for production')
    }
    return secret
  }
  return secret ?? DEV_SESSION_SECRET
}

// ── Production startup validation ─────────────────────────────────────────────
// Call once before listen(). Throws with a list of all offending var names.
// Never logs secret values.

export function validateProductionConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return

  const errors: string[] = []

  // SESSION_COOKIE_SECRET
  const secret = env.SESSION_COOKIE_SECRET
  if (!secret) {
    errors.push('SESSION_COOKIE_SECRET: missing')
  } else if (secret === DEV_SESSION_SECRET) {
    errors.push('SESSION_COOKIE_SECRET: must not be the dev placeholder')
  } else if (secret.length < MIN_SESSION_SECRET_LEN) {
    errors.push(`SESSION_COOKIE_SECRET: must be at least ${MIN_SESSION_SECRET_LEN} characters`)
  }

  // PILOT_PASSCODE
  const passcode = env.PILOT_PASSCODE
  if (!passcode) {
    errors.push('PILOT_PASSCODE: missing')
  } else if (WEAK_PASSCODES.has(passcode.toLowerCase())) {
    errors.push('PILOT_PASSCODE: must not be a default or weak value')
  } else if (passcode.length < MIN_PASSCODE_LEN) {
    errors.push(`PILOT_PASSCODE: must be at least ${MIN_PASSCODE_LEN} characters`)
  } else if (secret && passcode === secret) {
    errors.push('PILOT_PASSCODE: must not equal SESSION_COOKIE_SECRET')
  }

  // PILOT_USER_ID
  if (!env.PILOT_USER_ID) errors.push('PILOT_USER_ID: missing')

  // INTERNAL_INSPECTION_KEY
  const inspectionKey = env.INTERNAL_INSPECTION_KEY
  if (!inspectionKey) {
    errors.push('INTERNAL_INSPECTION_KEY: missing')
  } else if (inspectionKey.length < MIN_INSPECTION_KEY_LEN) {
    errors.push(`INTERNAL_INSPECTION_KEY: must be at least ${MIN_INSPECTION_KEY_LEN} characters`)
  } else if (passcode && inspectionKey === passcode) {
    errors.push('INTERNAL_INSPECTION_KEY: must not equal PILOT_PASSCODE')
  }

  // FRONTEND_ORIGIN
  const origin = env.FRONTEND_ORIGIN
  if (!origin) {
    errors.push('FRONTEND_ORIGIN: missing')
  } else {
    try {
      const u = new URL(origin)
      if (u.protocol !== 'https:') {
        errors.push('FRONTEND_ORIGIN: must use HTTPS')
      } else if (/localhost|127\.\d|192\.168\.|10\.\d|172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) {
        errors.push('FRONTEND_ORIGIN: must not be a local or LAN address')
      }
    } catch {
      errors.push('FRONTEND_ORIGIN: must be a valid URL')
    }
  }

  // DATABASE_URL
  const dbUrl = env.DATABASE_URL
  if (!dbUrl) {
    errors.push('DATABASE_URL: missing')
  } else if (/localhost|127\.0\.0\.1/.test(dbUrl)) {
    errors.push('DATABASE_URL: must not point at a local host in production')
  }

  // Audio storage
  const storageProvider = env.AUDIO_STORAGE_PROVIDER ?? env.STORAGE_MODE ?? 'local'
  if (storageProvider !== 'r2') {
    errors.push('AUDIO_STORAGE_PROVIDER: must be r2 in production (local storage is not allowed)')
  } else {
    for (const v of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      if (!env[v]) errors.push(`${v}: missing (required when AUDIO_STORAGE_PROVIDER=r2)`)
    }
  }

  // Transcription / extraction providers — must be explicitly openai; unknown values fall back to fake
  const txProvider = env.TRANSCRIPTION_PROVIDER
  if (txProvider !== 'openai') errors.push('TRANSCRIPTION_PROVIDER: must be openai in production')

  const exProvider = env.EXTRACTION_PROVIDER
  if (exProvider !== 'openai') errors.push('EXTRACTION_PROVIDER: must be openai in production')

  // OpenAI key
  if (!env.OPENAI_API_KEY) {
    errors.push('OPENAI_API_KEY: missing')
  }

  if (errors.length > 0) {
    throw new Error(
      `Production config validation failed — fix before deploying:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }
}
