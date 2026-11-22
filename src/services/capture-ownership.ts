import type { Prisma } from '@prisma/client'

export function captureError(code: string, message: string) {
  return { code, message }
}

export async function requireFileableJob(
  db: Pick<Prisma.TransactionClient, 'job'>,
  jobId: string,
  userId: string,
) {
  const job = await db.job.findUnique({ where: { id: jobId } })
  if (!job || job.ownerUserId !== userId)
    throw captureError('JOB_NOT_FOUND', 'Job not found')
  if (job.status === 'ARCHIVED')
    throw captureError('JOB_NOT_FILEABLE', 'This job is archived')
  return job
}

export async function lockNote(
  tx: Prisma.TransactionClient,
  noteId: string,
  ownerUserId: string,
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "raw_notes" WHERE id = ${noteId} AND "ownerUserId" = ${ownerUserId} FOR UPDATE
  `
  if (!rows.length) throw captureError('NOTE_NOT_FOUND', 'Note not found')
  return tx.rawNote.findUniqueOrThrow({ where: { id: noteId } })
}
