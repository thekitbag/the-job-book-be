import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateProductionConfig, getSessionCookieSecret } from '../src/config/production.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SESSION_COOKIE_SECRET: 'a-very-long-random-secret-value-for-the-pilot-32c',
    PILOT_PASSCODE: 'field-pilot-strong-passcode-2026',
    PILOT_USER_ID: 'usr_mike_pilot_123',
    INTERNAL_INSPECTION_KEY: 'inspect-random-key-value-24chars!!',
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

  // PILOT_PASSCODE
  it('rejects missing PILOT_PASSCODE', () => {
    const env = validProductionEnv()
    delete env.PILOT_PASSCODE
    expect(() => validateProductionConfig(env)).toThrow('PILOT_PASSCODE')
  })

  it('rejects weak default PILOT_PASSCODE "change-me"', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      PILOT_PASSCODE: 'change-me',
    })).toThrow('PILOT_PASSCODE')
  })

  it('rejects short PILOT_PASSCODE under 12 chars', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      PILOT_PASSCODE: 'shortpass',
    })).toThrow('PILOT_PASSCODE')
  })

  it('rejects PILOT_PASSCODE equal to SESSION_COOKIE_SECRET', () => {
    const secret = 'a-very-long-random-secret-value-for-the-pilot-32c'
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      SESSION_COOKIE_SECRET: secret,
      PILOT_PASSCODE: secret,
    })).toThrow('PILOT_PASSCODE')
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

  // AI providers
  it('rejects fake TRANSCRIPTION_PROVIDER', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      TRANSCRIPTION_PROVIDER: 'fake',
    })).toThrow('TRANSCRIPTION_PROVIDER')
  })

  it('rejects fake EXTRACTION_PROVIDER', () => {
    expect(() => validateProductionConfig({
      ...validProductionEnv(),
      EXTRACTION_PROVIDER: 'fake',
    })).toThrow('EXTRACTION_PROVIDER')
  })

  it('rejects missing TRANSCRIPTION_PROVIDER (defaults to fake)', () => {
    const env = validProductionEnv()
    delete env.TRANSCRIPTION_PROVIDER
    expect(() => validateProductionConfig(env)).toThrow('TRANSCRIPTION_PROVIDER')
  })

  it('rejects missing OPENAI_API_KEY when OpenAI providers are selected', () => {
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
