import { prisma } from '../db/client.js'
import type { AudioStorageProvider } from '../storage/index.js'
import type { TranscriptionProvider } from './types.js'

export async function runTranscription(
  noteId: string,
  provider: TranscriptionProvider,
  storage: AudioStorageProvider,
): Promise<void> {
  const note = await prisma.rawNote.findUnique({
    where: { id: noteId },
    include: { audioObject: true },
  })

  if (!note || !note.audioObject) return

  const transcript = await prisma.transcript.create({
    data: {
      noteId,
      status: 'TRANSCRIBING',
      provider: provider.name,
      model: provider.model,
      startedAt: new Date(),
    },
  })

  await prisma.rawNote.update({
    where: { id: noteId },
    data: { serverStatus: 'TRANSCRIBING' },
  })

  try {
    const audioBuffer = await storage.read(note.audioObject.storageKey)

    const result = await provider.transcribe({
      noteId,
      audioKey: note.audioObject.storageKey,
      audioBuffer,
      mimeType: note.mimeType,
    })

    await prisma.transcript.update({
      where: { id: transcript.id },
      data: {
        status: 'COMPLETED',
        text: result.text,
        language: result.language ?? null,
        confidence: result.confidence ?? null,
        providerResponseId: result.providerResponseId ?? null,
        completedAt: new Date(),
      },
    })

    await prisma.rawNote.update({
      where: { id: noteId },
      data: { serverStatus: 'TRANSCRIBED' },
    })
  } catch (err: unknown) {
    const errorCode = (err as { code?: string })?.code ?? 'UNKNOWN'
    const errorMessage = (err as { message?: string })?.message ?? String(err)

    // Raw note and audio object are preserved — only status is updated
    await prisma.transcript.update({
      where: { id: transcript.id },
      data: { status: 'FAILED', errorCode, errorMessage, completedAt: new Date() },
    }).catch(() => {})

    await prisma.rawNote.update({
      where: { id: noteId },
      data: { serverStatus: 'FAILED' },
    }).catch(() => {})
  }
}
