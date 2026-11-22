// Tests use an in-process fake storage provider and a real DB via DATABASE_URL.
// Set DATABASE_URL=postgresql://... in .env.test before running.
import { config } from 'dotenv'
config({ path: '.env.test', quiet: true })

// Existing money workflows exercise the explicit restore path. Strip-back tests unset this.
process.env.MONEY_FEATURES_ENABLED = 'true'
