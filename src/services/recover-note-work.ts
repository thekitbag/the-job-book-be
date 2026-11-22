import { prisma } from '../db/client.js'
import { staleBefore } from '../lib/worker-recovery.js'
import { runTranscription } from '../transcription/worker.js'
import { runExtraction } from '../extraction/worker.js'
import type { AppOptions } from '../app.js'

type Providers = Required<
  Pick<AppOptions, 'transcription' | 'extraction' | 'storage'>
>

export async function recoverNoteWork(
  providers: Providers,
  onError: (error: unknown, noteId: string) => void,
) {
  const cutoff = staleBefore()
  // Decide from the latest revision before filtering eligibility, so an old
  // pending revision cannot cause completed or failed work to run again.
  const work = await prisma.$queryRaw<
    {
      noteId: string
      transcriptId: string | null
      stage: 'transcription' | 'extraction'
    }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON ("noteId") id, "noteId", status, "startedAt", "updatedAt", "extractionStatus", "extractionStartedAt"
      FROM transcripts ORDER BY "noteId", revision DESC, "createdAt" DESC, id DESC
    )
    SELECT n.id AS "noteId", t.id AS "transcriptId", 'transcription' AS stage
    FROM raw_notes n JOIN audio_objects a ON a."noteId" = n.id
    LEFT JOIN latest t ON t."noteId" = n.id
    WHERE t.id IS NULL OR t.status = 'PENDING'
      OR (t.status = 'TRANSCRIBING' AND COALESCE(t."startedAt", t."updatedAt") < ${cutoff})
    UNION ALL
    SELECT n.id, t.id, 'extraction'
    FROM raw_notes n JOIN latest t ON t."noteId" = n.id
    WHERE n."jobId" IS NOT NULL AND t.status = 'COMPLETED'
      AND (t."extractionStatus" IS NULL OR t."extractionStatus" = 'PENDING'
        OR (t."extractionStatus" = 'EXTRACTING' AND COALESCE(t."extractionStartedAt", t."updatedAt") < ${cutoff}))
  `

  // Bound the number of provider calls even when a restart finds a backlog.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(work.length, 4) }, async () => {
      while (next < work.length) {
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
