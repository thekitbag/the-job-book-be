import 'dotenv/config'
import { exportMoney } from '../services/money-export.js'
import { prisma } from '../db/client.js'
const args = process.argv.slice(2)
const userId = args[args.indexOf('--user') + 1]
const out = args[args.indexOf('--out') + 1]
try {
  if (
    !args.includes('--user') ||
    !args.includes('--out') ||
    !userId ||
    !out ||
    userId.startsWith('--') ||
    out.startsWith('--')
  )
    throw new Error('Usage: npm run export:money -- --user <id> --out <dir>')
  const counts = await exportMoney(userId, out)
  for (const [table, count] of Object.entries(counts))
    console.log(`${table}: ${count}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Export failed')
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
