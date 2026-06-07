import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'

function toApiFactType(ft: string): string {
  return ft.toLowerCase()
}

function toApiStatus(s: string): string {
  return s.toLowerCase()
}

function toApiConfidence(cl: string): string {
  return cl.toLowerCase()
}

function formatFact(f: {
  id: string
  jobId: string
  sourceNoteId: string
  sourceTranscriptId: string
  factType: string
  status: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  deliveryTiming: string | null
  locationOrUse: string | null
  confidenceLabel: string
  confidenceReason: string
  uncertaintyFlags: string[]
  extractionProvider: string | null
  extractionModel: string | null
  extractionSchemaVersion: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: f.id,
    jobId: f.jobId,
    sourceNoteIds: [f.sourceNoteId],
    sourceTranscriptIds: [f.sourceTranscriptId],
    factType: toApiFactType(f.factType),
    status: toApiStatus(f.status),
    summary: f.summary,
    materialName: f.materialName,
    quantity: f.quantity,
    unit: f.unit,
    supplierName: f.supplierName,
    deliveryTiming: f.deliveryTiming,
    locationOrUse: f.locationOrUse,
    confidenceLabel: toApiConfidence(f.confidenceLabel),
    confidenceReason: f.confidenceReason,
    uncertaintyFlags: f.uncertaintyFlags,
    extractionProvider: f.extractionProvider,
    extractionModel: f.extractionModel,
    extractionSchemaVersion: f.extractionSchemaVersion,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }
}

export async function listFactsByJob(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const facts = await prisma.candidateFact.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  })

  return facts.map(formatFact)
}

export async function listFactsByNote(jobId: string, noteId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }

  const note = await prisma.rawNote.findFirst({ where: { id: noteId, jobId } })
  if (!note) throw { code: ErrorCode.NOTE_NOT_FOUND, message: 'Note not found' }

  const facts = await prisma.candidateFact.findMany({
    where: { sourceNoteId: noteId },
    orderBy: { createdAt: 'asc' },
  })

  return facts.map(formatFact)
}
