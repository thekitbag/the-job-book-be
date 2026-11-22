import type { Transcript } from '@prisma/client'

const STUCK_AFTER_MS = 5 * 60 * 1000

export function staleBefore(now = new Date()) {
  return new Date(now.getTime() - STUCK_AFTER_MS)
}

export const latestTranscriptOrder = [
  { revision: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
] as const

export function transcriptionNeedsWork(
  transcript: Transcript | null,
  cutoff: Date,
) {
  return (
    !transcript ||
    transcript.status === 'PENDING' ||
    (transcript.status === 'TRANSCRIBING' &&
      (transcript.startedAt ?? transcript.updatedAt) < cutoff)
  )
}
