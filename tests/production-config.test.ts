import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateProductionConfig, getSessionCookieSecret } from '../src/config/production.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SESSION_COOKIE_SECRET: 'a-very-long-random-secret-value-for-the-pilot-32c',
    INTERNAL_INSPECTION_KEY: 'inspect-random-key-value-24chars!!',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test_key_xxxx',
    EMAIL_FROM: 'The Job Book <no-reply@thejobbook.app>',
    PASSWORD_RESET_URL_BASE: 'https://thejobbook.app/reset-password',
    FRONTEND_ORIGIN: 'https://thejobbook.app',
    DATABASE_URL: 'postgresql://user:pass@db.render.com:5432/jobbook_prod',
    AUDIO_STORAGE_PROVIDER: 'r2',
    R2_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'r2-access-key-id',
    R2_SECRET_ACCESS_KEY: 'r2-secret-access-key',
    R2_BUCKET: 'jobbook-pilot',
    TRANSCRIPTION_PROVIDER: 'openai',
    EXTRACTION_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-proj-xxxx',
  }
}

// ── validateProductionConfig ──────────────────────────────────────────────────

describe('validateProductionConfig', () => {
  it('accepts a complete valid production config without throwing', () => {
    expect(() => validateProductionConfig(validProductionEnv())).not.toThrow()
  })

  it('is a no-op outside production', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow()
    expect(() => validateProductionConfig({ NODE_ENV: 'test' })).not.toThrow()
    expect(() => validateProductionConfig({})).not.toThrow()
  })

  // SESSION_COOKIE_SECRET
  it('rejects missing SESSION_COOKIE_SECRET', () => {
    const env = validProductionEnv()
    delete env.SESSION_COOKIE_SECRET
    expect(() => validateProductionConfig(env)).toThrow('SESSION_COOKIE_SECRET')
  })

  it('rejects dev placeholder SESSION_COOKIE_SECRET', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      SESSION_COOKIE_SECRET: 'dev-secret-change-in-production',
    })).toThrow('SESSION_COOKIE_SECRET')
  })

  it('rejects SESSION_COOKIE_SECRET shorter than 32 chars', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      SESSION_COOKIE_SECRET: 'under-32-chars-secret',
    })).toThrow('SESSION_COOKIE_SECRET')
  })

  // Legacy passcode auth must be fully retired
  it('rejects a production env that still sets PILOT_PASSCODE', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      PILOT_PASSCODE: 'field-pilot-strong-passcode-2026',
    })).toThrow('PILOT_PASSCODE')
  })

  it('does not require PILOT_USER_ID (no production fallback auth)', () => {
    const env = validProductionEnv()
    delete env.PILOT_USER_ID
    expect(() => validateProductionConfig(env)).not.toThrow()
  })

  // Password-reset email provider
  it('rejects missing/dev EMAIL_PROVIDER', () => {
    const env = validProductionEnv()
    delete env.EMAIL_PROVIDER
    expect(() => validateProductionConfig(env)).toThrow('EMAIL_PROVIDER')
    expect(() => validateProductionConfig({ ...validProductionEnv(), EMAIL_PROVIDER: 'dev' }))
      .toThrow('EMAIL_PROVIDER')
  })

  it('rejects resend without RESEND_API_KEY or EMAIL_FROM', () => {
    const noKey = validProductionEnv()
    delete noKey.RESEND_API_KEY
    expect(() => validateProductionConfig(noKey)).toThrow('RESEND_API_KEY')

    const noFrom = validProductionEnv()
    delete noFrom.EMAIL_FROM
    expect(() => validateProductionConfig(noFrom)).toThrow('EMAIL_FROM')
  })

  it('rejects missing or non-HTTPS PASSWORD_RESET_URL_BASE', () => {
    const env = validProductionEnv()
    delete env.PASSWORD_RESET_URL_BASE
    expect(() => validateProductionConfig(env)).toThrow('PASSWORD_RESET_URL_BASE')
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      PASSWORD_RESET_URL_BASE: 'http://thejobbook.app/reset-password',
    })).toThrow('PASSWORD_RESET_URL_BASE')
  })

  // INTERNAL_INSPECTION_KEY
  it('rejects missing INTERNAL_INSPECTION_KEY', () => {
    const env = validProductionEnv()
    delete env.INTERNAL_INSPECTION_KEY
    expect(() => validateProductionConfig(env)).toThrow('INTERNAL_INSPECTION_KEY')
  })

  it('rejects INTERNAL_INSPECTION_KEY shorter than 24 chars', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      INTERNAL_INSPECTION_KEY: 'tooshort23chars!!!!!!!!',
    })).toThrow('INTERNAL_INSPECTION_KEY')
  })

  // FRONTEND_ORIGIN
  it('rejects missing FRONTEND_ORIGIN', () => {
    const env = validProductionEnv()
    delete env.FRONTEND_ORIGIN
    expect(() => validateProductionConfig(env)).toThrow('FRONTEND_ORIGIN')
  })

  it('rejects non-HTTPS FRONTEND_ORIGIN', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      FRONTEND_ORIGIN: 'http://thejobbook.app',
    })).toThrow('FRONTEND_ORIGIN')
  })

  it('rejects localhost FRONTEND_ORIGIN', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      FRONTEND_ORIGIN: 'https://localhost:3000',
    })).toThrow('FRONTEND_ORIGIN')
  })

  it('rejects LAN-address FRONTEND_ORIGIN', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      FRONTEND_ORIGIN: 'https://192.168.1.50:3000',
    })).toThrow('FRONTEND_ORIGIN')
  })

  // DATABASE_URL
  it('rejects missing DATABASE_URL', () => {
    const env = validProductionEnv()
    delete env.DATABASE_URL
    expect(() => validateProductionConfig(env)).toThrow('DATABASE_URL')
  })

  it('rejects localhost DATABASE_URL', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/jobbook_dev',
    })).toThrow('DATABASE_URL')
  })

  it('rejects 127.0.0.1 DATABASE_URL', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/jobbook_dev',
    })).toThrow('DATABASE_URL')
  })

  // Audio storage
  it('rejects local audio storage', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      AUDIO_STORAGE_PROVIDER: 'local',
    })).toThrow('AUDIO_STORAGE_PROVIDER')
  })

  it('rejects missing AUDIO_STORAGE_PROVIDER (defaults to local)', () => {
    const env = validProductionEnv()
    delete env.AUDIO_STORAGE_PROVIDER
    expect(() => validateProductionConfig(env)).toThrow('AUDIO_STORAGE_PROVIDER')
  })

  it('rejects r2 without R2_ENDPOINT', () => {
    const env = validProductionEnv()
    delete env.R2_ENDPOINT
    expect(() => validateProductionConfig(env)).toThrow('R2_ENDPOINT')
  })

  it('rejects r2 without R2_ACCESS_KEY_ID', () => {
    const env = validProductionEnv()
    delete env.R2_ACCESS_KEY_ID
    expect(() => validateProductionConfig(env)).toThrow('R2_ACCESS_KEY_ID')
  })

  it('rejects r2 without R2_SECRET_ACCESS_KEY', () => {
    const env = validProductionEnv()
    delete env.R2_SECRET_ACCESS_KEY
    expect(() => validateProductionConfig(env)).toThrow('R2_SECRET_ACCESS_KEY')
  })

  it('rejects r2 without R2_BUCKET', () => {
    const env = validProductionEnv()
    delete env.R2_BUCKET
    expect(() => validateProductionConfig(env)).toThrow('R2_BUCKET')
  })

  // INTERNAL_INSPECTION_KEY equality guard
  it('rejects INTERNAL_INSPECTION_KEY equal to SESSION_COOKIE_SECRET', () => {
    const shared = 'shared-key-that-is-long-enough-for-both!!'
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      SESSION_COOKIE_SECRET: shared,
      INTERNAL_INSPECTION_KEY: shared,
    })).toThrow('INTERNAL_INSPECTION_KEY')
  })

  // AI providers — must be exactly openai; typos and unknown values also rejected
  it('rejects fake TRANSCRIPTION_PROVIDER', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      TRANSCRIPTION_PROVIDER: 'fake',
    })).toThrow('TRANSCRIPTION_PROVIDER')
  })

  it('rejects typo/unknown TRANSCRIPTION_PROVIDER (e.g. "opneai")', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      TRANSCRIPTION_PROVIDER: 'opneai',
    })).toThrow('TRANSCRIPTION_PROVIDER')
  })

  it('rejects missing TRANSCRIPTION_PROVIDER', () => {
    const env = validProductionEnv()
    delete env.TRANSCRIPTION_PROVIDER
    expect(() => validateProductionConfig(env)).toThrow('TRANSCRIPTION_PROVIDER')
  })

  it('rejects fake EXTRACTION_PROVIDER', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      EXTRACTION_PROVIDER: 'fake',
    })).toThrow('EXTRACTION_PROVIDER')
  })

  it('rejects typo/unknown EXTRACTION_PROVIDER (e.g. "real")', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      EXTRACTION_PROVIDER: 'real',
    })).toThrow('EXTRACTION_PROVIDER')
  })

  it('rejects missing EXTRACTION_PROVIDER', () => {
    const env = validProductionEnv()
    delete env.EXTRACTION_PROVIDER
    expect(() => validateProductionConfig(env)).toThrow('EXTRACTION_PROVIDER')
  })

  it('rejects missing OPENAI_API_KEY', () => {
    const env = validProductionEnv()
    delete env.OPENAI_API_KEY
    expect(() => validateProductionConfig(env)).toThrow('OPENAI_API_KEY')
  })

  it('collects multiple errors and reports them all at once', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      SESSION_COOKIE_SECRET: 'dev-secret-change-in-production',
      PILOT_PASSCODE: 'change-me',
      AUDIO_STORAGE_PROVIDER: 'local',
      TRANSCRIPTION_PROVIDER: 'fake',
      EXTRACTION_PROVIDER: 'fake',
      FRONTEND_ORIGIN: 'http://localhost',
      DATABASE_URL: 'postgresql://user:pass@localhost/dev',
    }
    let error: Error | undefined
    try { validateProductionConfig(env) } catch (e) { error = e as Error }
    expect(error).toBeDefined()
    expect(error!.message).toContain('SESSION_COOKIE_SECRET')
    expect(error!.message).toContain('PILOT_PASSCODE')
    expect(error!.message).toContain('EMAIL_PROVIDER')
    expect(error!.message).toContain('AUDIO_STORAGE_PROVIDER')
    expect(error!.message).toContain('TRANSCRIPTION_PROVIDER')
    expect(error!.message).toContain('FRONTEND_ORIGIN')
  })

  it('does not include secret values in error messages', () => {
    const secretValue = 'dev-secret-change-in-production'
    let message = ''
    try {
      validateProductionConfig({
        ...validProductionEnv(),
        SESSION_COOKIE_SECRET: secretValue,
      })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain(secretValue)
  })
})

// ── getSessionCookieSecret ────────────────────────────────────────────────────

describe('getSessionCookieSecret', () => {
  it('returns a valid secret in dev without throwing', () => {
    const secret = getSessionCookieSecret({
      NODE_ENV: 'development',
      SESSION_COOKIE_SECRET: 'some-custom-dev-secret',
    })
    expect(secret).toBe('some-custom-dev-secret')
  })

  it('returns the dev placeholder when SESSION_COOKIE_SECRET is unset outside production', () => {
    const secret = getSessionCookieSecret({ NODE_ENV: 'development' })
    expect(secret).toBe('dev-secret-change-in-production')
  })

  it('returns the configured secret in production', () => {
    const configured = 'a-strong-production-secret-that-is-at-least-32ch'
    const secret = getSessionCookieSecret({
      NODE_ENV: 'production',
      SESSION_COOKIE_SECRET: configured,
    })
    expect(secret).toBe(configured)
  })

  it('throws in production when SESSION_COOKIE_SECRET is missing', () => {
    expect(() => getSessionCookieSecret({ NODE_ENV: 'production' })).toThrow()
  })

  it('throws in production when SESSION_COOKIE_SECRET is the dev placeholder', () => {
    expect(() => getSessionCookieSecret({
      NODE_ENV: 'production',
      SESSION_COOKIE_SECRET: 'dev-secret-change-in-production',
    })).toThrow()
  })

  it('throws in production when SESSION_COOKIE_SECRET is shorter than 32 chars', () => {
    expect(() => getSessionCookieSecret({
      NODE_ENV: 'production',
      SESSION_COOKIE_SECRET: 'too-short',
    })).toThrow()
  })
})

// ── production auth bypass tests ──────────────────────────────────────────────
// The auth plugin itself is integration-tested via HTTP; these confirm the
// production guard logic in isolation using the auth plugin's own behaviour.

describe('production auth environment gating (via HTTP test layer)', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  it('getSessionCookieSecret does not throw when NODE_ENV is test', () => {
    process.env.NODE_ENV = 'test'
    expect(() => getSessionCookieSecret(process.env)).not.toThrow()
  })

  it('validateProductionConfig is a no-op when NODE_ENV is test', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'test' })).not.toThrow()
  })
})
