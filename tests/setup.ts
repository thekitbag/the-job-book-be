// Tests use an in-process fake storage provider and a real DB via DATABASE_URL.
// Set DATABASE_URL=postgresql://... in .env.test before running.
import { config } from 'dotenv'
import { beforeAll, expect } from 'vitest'
config({ path: '.env.test', quiet: true })

// The default suite verifies restoration. The separate memory-only CI profile
// starts every test file with the production default: MONEY_FEATURES_ENABLED absent.
if (process.env.TEST_PROFILE === 'job-memory') delete process.env.MONEY_FEATURES_ENABLED
else process.env.MONEY_FEATURES_ENABLED = 'true'

if (process.env.TEST_PROFILE === 'job-memory') {
  beforeAll(() => expect(process.env.MONEY_FEATURES_ENABLED).toBeUndefined())
}
