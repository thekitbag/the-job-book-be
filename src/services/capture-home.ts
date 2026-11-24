import { prisma } from '../db/client.js'
import { deriveFreshQueueSections } from './review-queue.js'
import { getWorkshop } from './workshop.js'
import { capturePhoto } from './capture-photos.js'

export const latestTranscript = {
  orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
  take: 1,
} as const

export async function getUnfiled(userId: string) {
  const [notes, photos] = await Promise.all([
    prisma.rawNote.findMany({
      where: { ownerUserId: userId, jobId: null },
      orderBy: [{ capturedAt: 'desc' }, { id: 'asc' }],
      include: {
        transcripts: { orderBy: [...latestTranscript.orderBy], take: 1 },
      },
    }),
    prisma.jobPhoto.findMany({
      where: {
        uploadedByUserId: userId,
        jobId: null,
        isDeleted: false,
        kind: 'PHOTO',
      },
      orderBy: [{ uploadedAt: 'desc' }, { id: 'asc' }],
    }),
  ])
  return {
    notes: notes.map((n) => {
      const t = n.transcripts[0]
      const transcriptStatus =
        t?.status === 'COMPLETED'
          ? 'completed'
          : t?.status === 'FAILED'
            ? 'failed'
            : 'pending'
      return {
        noteId: n.id,
        capturedAt: n.capturedAt,
        durationMs: n.durationMs,
        transcriptStatus,
        text: transcriptStatus === 'completed' ? t.text : null,
      }
    }),
    photos: photos.map((p) => ({
      photoId: p.id,
      uploadedAt: p.uploadedAt,
      fileUrl: capturePhoto(p).fileUrl,
    })),
  }
}

export async function getCaptureHome(userId: string) {
  const [jobs, notesCount, photosCount, lastRecorded, workshop] =
    await Promise.all([
      prisma.job.findMany({
        where: { ownerUserId: userId, status: { not: 'ARCHIVED' } },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          rawNotes: {
            select: { capturedAt: true },
            orderBy: { capturedAt: 'desc' },
            take: 1,
          },
          photos: {
            where: { isDeleted: false },
            select: { uploadedAt: true },
            orderBy: { uploadedAt: 'desc' },
            take: 1,
          },
          memoryItems: {
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          reviewDecisions: {
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.rawNote.count({ where: { ownerUserId: userId, jobId: null } }),
      prisma.jobPhoto.count({
        where: {
          uploadedByUserId: userId,
          jobId: null,
          kind: 'PHOTO',
          isDeleted: false,
        },
      }),
      prisma.rawNote.findFirst({
        where: {
          ownerUserId: userId,
          filedAt: { not: null },
          job: { ownerUserId: userId, status: { not: 'ARCHIVED' } },
        },
        orderBy: [{ filedAt: 'desc' }, { id: 'asc' }],
        select: { jobId: true },
      }),
      getWorkshop(userId),
    ])
  const now = new Date()
  const inProgressJobs = await Promise.all(
    jobs
      .filter((j) => j.status === 'STARTED')
      .map(async (j) => {
        const dates = [
          j.rawNotes[0]?.capturedAt,
          j.photos[0]?.uploadedAt,
          j.memoryItems[0]?.createdAt,
          j.reviewDecisions[0]?.createdAt,
        ].filter((date): date is Date => date != null)
        return {
          id: j.id,
          title: j.title,
          lastActivityAt: dates.length
            ? new Date(Math.max(...dates.map((d) => d.getTime())))
            : j.createdAt,
          toCheckCount: (await deriveFreshQueueSections(j.id, now, false)).items
            .length,
        }
      }),
  )
  inProgressJobs.sort(
    (a, b) => +b.lastActivityAt - +a.lastActivityAt || a.id.localeCompare(b.id),
  )
  return {
    inProgressJobs,
    otherJobs: {
      planningCount: jobs.filter((j) => j.status === 'PLANNING').length,
      finishedCount: jobs.filter((j) => j.status === 'FINISHED').length,
    },
    unfiledCount: notesCount + photosCount,
    lastRecordedJobId: lastRecorded?.jobId ?? null,
    workshop: {
      availableCount: workshop.bookHome.availableCount,
      preview: workshop.bookHome.previewItems.map((p) => p.materialName),
    },
  }
}
