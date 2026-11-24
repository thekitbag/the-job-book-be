import { prisma } from '../db/client.js'
import { staleBefore } from '../lib/worker-recovery.js'
import { runTranscription } from '../transcription/worker.js'
import { runExtraction } from '../extraction/worker.js'
import type { AppOptions } from '../app.js'

type Providers = Required<
  Pick<AppOptions, 'transcription' | 'extraction' | 'storage'>
>

const SCAN_INTERVAL_MS = 60_000
const MAX_UPLOAD_AGE_MS = 7 * 24 * 60 * 60_000
type RecoveryErrorHandler = (error: unknown, noteId?: string) => void

export function startNoteRecovery(
  providers: Providers,
  onError: RecoveryErrorHandler,
) {
  const stop = new AbortController()
  let active: Promise<void> | undefined
  function scan() {
    if (stop.signal.aborted || active) return
    active = recoverNoteWork(providers, onError, stop.signal)
      .catch((error) => onError(error))
      .finally(() => {
        active = undefined
      })
  }

  scan()
  const timer = setInterval(scan, SCAN_INTERVAL_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    stop.abort()
    await active
  }
}

async function recoverNoteWork(
  providers: Providers,
  onError: RecoveryErrorHandler,
  signal: AbortSignal,
) {
  const now = new Date()
  const cutoff = staleBefore(now)
  const uploadedSince = new Date(now.getTime() - MAX_UPLOAD_AGE_MS)
  // Decide from the latest revision before filtering eligibility, so an old
  // pending revision cannot cause completed or failed work to run again.
  const work = await prisma.$queryRaw<
    {
      noteId: string
      transcriptId: string | null
      stage: 'transcription' | 'extraction'
    }[]
  >`
    WITH recent_notes AS (
      SELECT id, "jobId" FROM raw_notes WHERE "uploadedAt" >= ${uploadedSince}
    ), latest AS (
      SELECT DISTINCT ON (t."noteId") t.id, t."noteId", t.status, t."startedAt",
        t."updatedAt", t."extractionStatus", t."extractionStartedAt"
      FROM transcripts t JOIN recent_notes n ON n.id = t."noteId"
      ORDER BY t."noteId", t.revision DESC, t."createdAt" DESC, t.id DESC
    )
    SELECT n.id AS "noteId", t.id AS "transcriptId", 'transcription' AS stage
    FROM recent_notes n JOIN audio_objects a ON a."noteId" = n.id
    LEFT JOIN latest t ON t."noteId" = n.id
    WHERE t.id IS NULL OR t.status = 'PENDING'
      OR (t.status = 'TRANSCRIBING' AND COALESCE(t."startedAt", t."updatedAt") < ${cutoff})
    UNION ALL
    SELECT n.id, t.id, 'extraction'
    FROM recent_notes n JOIN latest t ON t."noteId" = n.id
    WHERE n."jobId" IS NOT NULL AND t.status = 'COMPLETED'
      AND (t."extractionStatus" IS NULL OR t."extractionStatus" = 'PENDING'
        OR (t."extractionStatus" = 'EXTRACTING' AND COALESCE(t."extractionStartedAt", t."updatedAt") < ${cutoff}))
  `

  // Bound the number of provider calls even when a restart finds a backlog.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(work.length, 4) }, async () => {
      while (!signal.aborted && next < work.length) {
        const task = work[next++]
        try {
          if (task.stage === 'transcription') {
            await runTranscription(
              task.noteId,
              providers.transcription,
              providers.storage,
              providers.extraction,
            )
          } else if (task.transcriptId)
            await runExtraction(task.transcriptId, providers.extraction)
        } catch (error) {
          onError(error, task.noteId)
        }
      }
    }),
  )
}
