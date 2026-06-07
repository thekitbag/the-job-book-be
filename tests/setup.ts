// Tests use an in-process fake storage provider and a real DB via DATABASE_URL.
// Set DATABASE_URL=postgresql://... in .env.test before running.
import { config } from 'dotenv'
config({ path: '.env.test', quiet: true })
