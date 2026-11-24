import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

export async function getJobLog(jobId: string, userId: string) {
  const job = await prisma.job.findFirst({
    where: { id: jobId, ownerUserId: userId },
    select: { id: true },
  })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  const [notes, typed, photos] = await Promise.all([
    prisma.rawNote.findMany({
      where: { jobId },
      include: {
        transcripts: { orderBy: { revision: 'desc' } },
        linkedPhotos: { where: { isDeleted: false }, select: { id: true } },
      },
    }),
    prisma.memoryItem.findMany({
      where: {
        jobId,
        isManual: true,
        isRemoved: false,
        sourceCandidateFactId: null,
        memoryType: {
          in: [
            'GENERAL_NOTE',
            'CUSTOMER_CHANGE',
            'WATCH_OUT',
            'SUPPLIER_DELIVERY_NOTE',
          ],
        },
      },
    }),
    prisma.jobPhoto.findMany({ where: { jobId, isDeleted: false } }),
  ])
  const entries = [
    ...notes.map((n) => {
      const completed = n.transcripts.find((t) => t.status === 'COMPLETED')
      const failed =
        n.transcripts[0]?.status === 'FAILED' || n.serverStatus === 'FAILED'
      return {
        kind: 'voice_note' as const,
        id: n.id,
        noteId: n.id,
        at: n.capturedAt.toISOString(),
        durationMs: n.durationMs,
        transcriptStatus: completed
          ? ('completed' as const)
          : failed
            ? ('failed' as const)
            : ('pending' as const),
        text: completed?.text ?? null,
        linkedPhotoIds: n.linkedPhotos.map((p) => p.id),
      }
    }),
    ...typed.map((m) => ({
      kind: 'typed_note' as const,
      id: m.id,
      memoryItemId: m.id,
      at: (m.happenedAt ?? m.createdAt).toISOString(),
      text: m.summary,
    })),
    ...photos.map((p) => ({
      kind: 'photo' as const,
      id: p.id,
      photoId: p.id,
      at: p.uploadedAt.toISOString(),
      fileKind: p.fileKind,
      fileUrl: `/api/jobs/${jobId}/${p.kind === 'RECEIPT' ? 'receipts' : 'photos'}/${p.id}/file`,
      descriptor: p.descriptor,
      linkedNoteId: p.linkedNoteId,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return { entries }
}
