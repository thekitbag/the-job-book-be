import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/client.js'

function csvValue(value: unknown): string {
  const raw =
    value instanceof Date
      ? value.toISOString()
      : value == null
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  // Spreadsheet formula injection protection for builder-entered text.
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replace(/"/g, '""')}"`
}
export function csvRows(
  rows: Record<string, unknown>[],
  columns: string[] = [],
): string {
  const keys = [
    ...new Set([...columns, ...rows.flatMap((row) => Object.keys(row))]),
  ]
  return (
    [
      keys.map(csvValue).join(','),
      ...rows.map((row) => keys.map((k) => csvValue(row[k])).join(',')),
    ].join('\r\n') + '\r\n'
  )
}
export async function exportMoney(userId: string, outDir: string) {
  const tables = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const job = { ownerUserId: userId }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      })
      if (!user) throw new Error('User not found')
      const withJob = { job: { select: { title: true } } } as const
      const costed = {
        OR: [
          { costAmount: { not: null } },
          { totalCostAmount: { not: null } },
          { refundAmount: { not: null } },
        ],
      }
      const [categories, items, labour, payments, events, suppliers] =
        await Promise.all([
          tx.jobBudgetCategory.findMany({
            where: { job },
            include: withJob,
            orderBy: { id: 'asc' },
          }),
          tx.memoryItem.findMany({
            where: { job, ...costed },
            include: withJob,
            orderBy: { id: 'asc' },
          }),
          tx.memoryItem.findMany({
            where: { job, memoryType: 'LABOUR', ...costed },
            include: withJob,
            orderBy: { id: 'asc' },
          }),
          tx.jobPayment.findMany({
            where: { job },
            include: withJob,
            orderBy: { id: 'asc' },
          }),
          tx.jobMoneyEvent.findMany({
            where: { job },
            include: withJob,
            orderBy: { id: 'asc' },
          }),
          tx.supplierAccountPayment.findMany({
            where: { ownerUserId: userId },
            include: {
              moneyEvents: {
                select: { jobId: true, job: { select: { title: true } } },
              },
            },
            orderBy: { id: 'asc' },
          }),
        ])
      const flatten = (rows: { job: { title: string } }[]) =>
        rows.map(({ job, ...row }) => ({ ...row, jobTitle: job.title }))
      return {
        'budget-categories': flatten(categories),
        'costed-memory-items': flatten(items),
        'labour-with-cost': flatten(labour),
        'customer-payments': flatten(payments),
        'money-events': flatten(events),
        'supplier-payments': suppliers.map(({ moneyEvents, ...row }) => ({
          ...row,
          jobTitle: [...new Set(moneyEvents.map((e) => e.job.title))].join(
            '; ',
          ),
          jobIds: [...new Set(moneyEvents.map((e) => e.jobId))].join('; '),
        })),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
  await mkdir(outDir, { recursive: true })
  const counts: Record<string, number> = {}
  const models: Record<string, string> = {
    'budget-categories': 'JobBudgetCategory',
    'costed-memory-items': 'MemoryItem',
    'labour-with-cost': 'MemoryItem',
    'customer-payments': 'JobPayment',
    'money-events': 'JobMoneyEvent',
    'supplier-payments': 'SupplierAccountPayment',
  }
  for (const [name, rows] of Object.entries(tables)) {
    const columns = [
      ...Prisma.dmmf.datamodel.models
        .find((m) => m.name === models[name])!
        .fields.filter((f) => f.kind !== 'object')
        .map((f) => f.name),
      'jobTitle',
      ...(name === 'supplier-payments' ? ['jobIds'] : []),
    ]
    await writeFile(join(outDir, `${name}.csv`), csvRows(rows, columns), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    counts[name] = rows.length
  }
  return counts
}
