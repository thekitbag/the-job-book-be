import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'
import type {
  CandidateFactDraft,
  ExtractionProvider,
} from '../src/extraction/types.js'
import type { TranscriptionProvider } from '../src/transcription/types.js'

const storage = new FakeAudioStorage()
const calls = new Map<string, number>()
const controlled = new Map<string, () => void>()
const jobs: string[] = []
const token = randomUUID()
let owner: string,
  stranger: string,
  first: string,
  second: string,
  archived: string,
  foreign: string
let base: string
const captureTime = new Date().toISOString()
const facts: CandidateFactDraft[] = [
  {
    factType: 'labour',
    summary: 'Six hours on the roof',
    labourHours: '6',
    labourTask: 'roof',
    confidenceLabel: 'high',
    confidenceReason: 'Stated',
    uncertaintyFlags: [],
  },
  {
    factType: 'ordered_material',
    summary: 'About three sheets of OSB',
    materialName: 'OSB',
    quantity: '3',
    unit: 'sheets',
    confidenceLabel: 'medium',
    confidenceReason: 'Approximate',
    uncertaintyFlags: ['approximate_quantity'],
  },
  {
    factType: 'leftover_material',
    summary: 'Two sheets left',
    materialName: 'ply',
    quantity: '2',
    unit: 'sheets',
    confidenceLabel: 'high',
    confidenceReason: 'Stated',
    uncertaintyFlags: [],
  },
]
const transcription: TranscriptionProvider = {
  name: 'test',
  model: 'test',
  async transcribe(input) {
    const scenario = input.audioBuffer.toString()
    if (scenario === 'delayed')
      await new Promise<void>((resolve) =>
        controlled.set(input.noteId, resolve),
      )
    return { text: scenario === 'silent' ? '' : scenario }
  },
}
const extraction: ExtractionProvider = {
  name: 'test',
  model: 'test',
  async extractFacts(input) {
    calls.set(input.noteId, (calls.get(input.noteId) ?? 0) + 1)
    const selected =
      input.transcriptText === 'empty'
        ? []
        : input.transcriptText === 'grouped'
          ? [
              facts[1],
              { ...facts[2], quantity: '5' },
              {
                factType: 'unclear',
                summary: 'Unknown item',
                confidenceLabel: 'low',
                confidenceReason: 'Unclear',
                uncertaintyFlags: ['uncertain'],
              } as const,
            ]
          : input.transcriptText === 'stale'
            ? facts.slice(0, 2)
            : facts
    return {
      facts: selected.map((f) => ({
        ...f,
        uncertaintyFlags: [...f.uncertaintyFlags],
      })),
      schemaVersion: 'v3-job-memory',
    }
  },
}
const app = buildApp({ storage, transcription, extraction })

async function createJob(
  userId: string,
  title: string,
  status: 'STARTED' | 'ARCHIVED' | 'PLANNING' | 'FINISHED' = 'STARTED',
) {
  const row = await prisma.job.create({
    data: { ownerUserId: userId, title, jobType: 'garden_room', status },
  })
  jobs.push(row.id)
  return row.id
}

beforeAll(async () => {
  vi.stubEnv('MONEY_FEATURES_ENABLED', undefined)
  owner = (
    await prisma.user.create({
      data: { email: `capture-${token}@example.test`, name: 'Mike' },
    })
  ).id
  stranger = (
    await prisma.user.create({
      data: { email: `other-capture-${token}@example.test`, name: 'Kurt' },
    })
  ).id
  first = await createJob(owner, 'First')
  second = await createJob(owner, 'Second')
  archived = await createJob(owner, 'Archived', 'ARCHIVED')
  foreign = await createJob(stranger, 'Foreign')
  await createJob(owner, 'Planning', 'PLANNING')
  await createJob(owner, 'Finished', 'FINISHED')
  base = await app.listen({ host: '127.0.0.1', port: 0 })
})

afterAll(async () => {
  for (const resolve of controlled.values()) resolve()
  await app.close()
  const noteIds = (
    await prisma.rawNote.findMany({
      where: { ownerUserId: { in: [owner, stranger] } },
      select: { id: true },
    })
  ).map((n) => n.id)
  const jobId = { in: jobs }
  await prisma.itemMove.deleteMany({
    where: { ownerUserId: { in: [owner, stranger] } },
  })
  await prisma.jobPhoto.deleteMany({
    where: { uploadedByUserId: { in: [owner, stranger] } },
  })
  await prisma.jobMoneyEvent.deleteMany({ where: { jobId } })
  await prisma.workshopItem.deleteMany({ where: { ownerUserId: owner } })
  await prisma.memoryItem.deleteMany({ where: { jobId } })
  await prisma.reviewDecision.deleteMany({ where: { jobId } })
  await prisma.queueItem.deleteMany({ where: { jobId } })
  await prisma.candidateFact.deleteMany({ where: { jobId } })
  await prisma.audioObject.deleteMany({ where: { noteId: { in: noteIds } } })
  await prisma.transcript.deleteMany({ where: { noteId: { in: noteIds } } })
  await prisma.rawNote.deleteMany({ where: { id: { in: noteIds } } })
  await prisma.jobBudgetCategory.deleteMany({ where: { jobId } })
  await prisma.job.deleteMany({ where: { id: jobId } })
  await prisma.user.deleteMany({ where: { id: { in: [owner, stranger] } } })
  vi.unstubAllEnvs()
})

async function http(
  path: string,
  options: { body?: FormData | object; user?: string; status?: number } = {},
) {
  const headers: Record<string, string> = {
    'x-pilot-user-id': options.user ?? owner,
  }
  const multipart = options.body instanceof FormData
  if (options.body && !multipart) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: multipart
      ? (options.body as FormData)
      : options.body
        ? JSON.stringify(options.body)
        : undefined,
  })
  const body = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : await res.text()
  expect(res.status, `${path}: ${JSON.stringify(body)}`).toBe(
    options.status ?? 200,
  )
  if (process.env.CAPTURE_WORKFLOW_EVIDENCE && typeof body === 'object') {
    const excerpt = body.hours
      ? {
          totalHours: body.hours.totalHours,
          stillToCheck: body.stillToCheck.count,
        }
      : body
    appendFileSync(
      process.env.CAPTURE_WORKFLOW_EVIDENCE,
      JSON.stringify({ path, status: res.status, body: excerpt }) + '\n',
    )
  }
  return body
}
function noteForm(
  scenario: string,
  jobId?: string,
  clientNoteId = randomUUID(),
) {
  const form = new FormData()
  form.set(
    'audio',
    new Blob([scenario], { type: 'audio/webm' }),
    'capture.webm',
  )
  form.set('mimeType', 'audio/webm;codecs=opus')
  form.set('clientNoteId', clientNoteId)
  form.set('capturedAt', captureTime)
  form.set('durationMs', '4000')
  form.set('captureContext', 'home')
  if (jobId) form.set('jobId', jobId)
  return form
}
const draft = (id: string) => http(`/api/notes/${id}/draft`)
const file = (id: string, jobId: string, status = 200) =>
  http(`/api/notes/${id}/file`, { body: { jobId }, status })
const move = (id: string, jobId: string, status = 200) =>
  http(`/api/notes/${id}/move`, { body: { jobId }, status })
const looks = (id: string, queueItemIds: string[], status = 200) =>
  http(`/api/notes/${id}/looks-right`, { body: { queueItemIds }, status })
const upload = (scenario: string, jobId?: string) =>
  http('/api/notes', { body: noteForm(scenario, jobId), status: 201 })
async function waitReady(id: string) {
  await expect
    .poll(async () => (await draft(id)).state, { timeout: 5000 })
    .toBe('ready')
  return draft(id)
}

describe('Record from Home over local HTTP and PostgreSQL', () => {
  it('uploads unfiled, files after transcription, confirms only shown checks, then moves the entire note', async () => {
    const { note } = await upload('workflow')
    expect(note).toMatchObject({
      jobId: null,
      filedAt: null,
      captureContext: 'home',
      serverStatus: 'UPLOADED',
    })
    expect(
      (await prisma.rawNote.findUniqueOrThrow({ where: { id: note.id } }))
        .mimeType,
    ).toBe('audio/webm;codecs=opus')
    expect(await draft(note.id)).toMatchObject({
      state: 'not_filed',
      items: [],
      moreToCheckCount: 0,
    })
    await expect
      .poll(
        async () =>
          (await http('/api/unfiled')).notes.find(
            (n: any) => n.noteId === note.id,
          )?.transcriptStatus,
      )
      .toBe('completed')
    expect(calls.get(note.id)).toBeUndefined()
    expect(await http(`/api/jobs/${first}/notes`)).toEqual([])
    expect(await file(note.id, archived, 409)).toMatchObject({
      code: 'JOB_NOT_FILEABLE',
    })
    expect(await file(note.id, foreign, 404)).toMatchObject({
      code: 'JOB_NOT_FOUND',
    })
    for (const response of await Promise.all([
      file(note.id, first),
      file(note.id, first),
    ])) {
      expect(response).toMatchObject({ note: { jobId: first } })
    }
    const ready = await waitReady(note.id)
    expect(calls.get(note.id)).toBe(1)
    const hours = ready.items.find((i: any) => i.kind === 'hours')
    const material = ready.items.find((i: any) => i.item === 'OSB')
    const pending = ready.items.find((i: any) => i.item === 'ply')
    expect(ready).toMatchObject({
      transcriptText: 'workflow',
      moreToCheckCount: 0,
    })
    expect(hours).toMatchObject({
      person: 'Mike',
      hours: '6',
      uncertain: false,
    })
    expect(material).toMatchObject({ amount: '3 sheets', uncertain: true })
    expect(
      await looks(note.id, [hours.queueItemId, material.queueItemId]),
    ).toEqual({
      confirmed: [hours.queueItemId, material.queueItemId],
      alreadyDecided: [],
    })
    expect(await looks(note.id, [hours.queueItemId])).toEqual({
      confirmed: [],
      alreadyDecided: [hours.queueItemId],
    })
    const costed = await prisma.memoryItem.findFirstOrThrow({
      where: { jobId: first, materialName: 'OSB' },
    })
    expect(costed.unresolvedFlags).toEqual(['approximate_quantity'])
    expect(
      await prisma.reviewDecision.count({
        where: { jobId: first, action: 'NOTE_LOOKS_RIGHT' },
      }),
    ).toBe(2)
    expect(
      (await http(`/api/jobs/${first}/memory-view`)).hours.totalHours,
    ).toBe('6')
    const changed = await http(`/api/jobs/${first}/review-queue-decisions`, {
      body: {
        action: 'correct',
        queueItemId: pending.queueItemId,
        corrected: {
          memoryType: 'leftover_material',
          materialName: 'ply',
          quantity: '4',
          unit: 'sheets',
          summary: 'Four sheets',
        },
      },
    })
    const workshop = await http(
      `/api/jobs/${first}/memory-items/${changed.memoryItemId}/workshop`,
      { body: {}, status: 201 },
    )
    const extra = await prisma.candidateFact.create({
      data: {
        jobId: first,
        sourceNoteId: note.id,
        sourceTranscriptId: (
          await prisma.transcript.findFirstOrThrow({
            where: { noteId: note.id },
          })
        ).id,
        factType: 'USED_MATERIAL',
        summary: 'Used nails',
        materialName: 'nails',
        quantity: '4',
        confidenceLabel: 'HIGH',
        confidenceReason: 'Stated',
      },
    })
    const linkedPhoto = await prisma.jobPhoto.create({
      data: {
        jobId: first,
        uploadedByUserId: owner,
        storageKey: randomUUID(),
        bucket: 'test',
        mimeType: 'image/jpeg',
        sizeBytes: 12,
        linkedNoteId: note.id,
        filedAt: new Date(),
      },
    })
    const cat = await prisma.jobBudgetCategory.create({
      data: { jobId: first, name: 'Historical' },
    })
    await prisma.memoryItem.update({
      where: { id: costed.id },
      data: { budgetCategoryId: cat.id },
    })
    expect(await move(note.id, second, 409)).toMatchObject({
      code: 'NOTE_MOVE_BLOCKED',
    })
    expect((await draft(note.id)).jobId).toBe(first)
    await prisma.memoryItem.update({
      where: { id: costed.id },
      data: { budgetCategoryId: null },
    })
    expect(await move(note.id, second)).toMatchObject({
      note: { jobId: second },
    })
    expect(
      (await http(`/api/jobs/${first}/memory-view`)).hours.totalHours,
    ).toBe('0')
    expect(
      (await http(`/api/jobs/${second}/memory-view`)).hours.totalHours,
    ).toBe('6')
    expect(
      await prisma.candidateFact.findUniqueOrThrow({ where: { id: extra.id } }),
    ).toMatchObject({ jobId: second, status: 'DRAFT' })
    expect(
      await prisma.memoryItem.findUniqueOrThrow({
        where: { id: changed.memoryItemId },
      }),
    ).toMatchObject({ jobId: second, quantity: '4' })
    expect(
      await prisma.workshopItem.findUniqueOrThrow({
        where: { id: workshop.workshopItem.id },
      }),
    ).toMatchObject({ sourceJobId: second, state: 'AVAILABLE' })
    expect(
      await prisma.jobPhoto.findUniqueOrThrow({
        where: { id: linkedPhoto.id },
      }),
    ).toMatchObject({
      jobId: second,
      linkedNoteId: note.id,
    })
    expect(
      await prisma.itemMove.count({
        where: { noteId: note.id, fromJobId: first, toJobId: second },
      }),
    ).toBe(1)
  })

  it('claims extraction once when two files and a duplicate upload race a transcript', async () => {
    const clientId = randomUUID()
    const { note } = await http('/api/notes', {
      body: noteForm('delayed', undefined, clientId),
      status: 201,
    })
    await expect.poll(() => controlled.has(note.id)).toBe(true)
    const placed = await Promise.all([
      file(note.id, first),
      file(note.id, first),
      http('/api/notes', {
        body: noteForm('delayed', first, clientId),
        status: 200,
      }),
    ])
    expect(placed.map((r) => r.note.id)).toEqual([note.id, note.id, note.id])
    expect(calls.get(note.id)).toBeUndefined()
    controlled.get(note.id)!()
    await waitReady(note.id)
    expect(calls.get(note.id)).toBe(1)
    expect(await prisma.transcript.count({ where: { noteId: note.id } })).toBe(
      1,
    )
    expect(await file(note.id, second, 409)).toMatchObject({
      code: 'NOTE_ALREADY_FILED',
    })
    expect(
      await http(`/api/notes/${note.id}/draft`, {
        user: stranger,
        status: 404,
      }),
    ).toMatchObject({ code: 'NOTE_NOT_FOUND' })
    for (const action of ['file', 'move', 'looks-right']) {
      await http(`/api/notes/${note.id}/${action}`, {
        body:
          action === 'looks-right' ? { queueItemIds: [] } : { jobId: first },
        user: stranger,
        status: 404,
      })
    }
  })

  it('serializes identical Looks right calls and keeps the second response idempotent', async () => {
    const job = await createJob(owner, 'Parallel confirmation')
    const { note } = await upload('workflow', job)
    const ready = await waitReady(note.id)
    const ids = ready.items.map((i: { queueItemId: string }) => i.queueItemId)
    const results = await Promise.all([
      looks(note.id, ids),
      looks(note.id, ids),
    ])
    expect(results.flatMap((r) => r.confirmed)).toEqual(ids)
    expect(results.flatMap((r) => r.alreadyDecided)).toEqual(ids)
    expect(
      await prisma.reviewDecision.count({
        where: { jobId: job, action: 'NOTE_LOOKS_RIGHT' },
      }),
    ).toBe(ids.length)
  })

  it('rejects a stale single atomically, counts grouped/unclear facts, and rejects another note ID', async () => {
    const job = await createJob(owner, 'Grouping')
    const { note: a } = await upload('stale', job)
    const firstDraft = await waitReady(a.id)
    const aHours = firstDraft.items.find((i: any) => i.kind === 'hours')
    const aMaterial = firstDraft.items.find((i: any) => i.kind === 'material')
    const { note: b } = await upload('grouped', job)
    const { note: c } = await upload('workflow', job)
    await waitReady(b.id)
    const other = await waitReady(c.id)
    expect(await draft(a.id)).toMatchObject({
      items: [aHours],
      moreToCheckCount: 1,
    })
    expect(await draft(b.id)).toMatchObject({ items: [], moreToCheckCount: 3 })
    expect(other.moreToCheckCount).toBe(2)
    expect(
      await looks(a.id, [aHours.queueItemId, aMaterial.queueItemId], 409),
    ).toMatchObject({ code: 'DRAFT_CHANGED' })
    expect(
      await looks(a.id, [aHours.queueItemId, other.items[0].queueItemId], 400),
    ).toMatchObject({ code: 'INVALID_FIELD' })
    expect(await prisma.memoryItem.count({ where: { jobId: job } })).toBe(0)
  })

  it('makes a silent recording ready without calling extraction', async () => {
    const { note } = await upload('silent', first)
    expect(await waitReady(note.id)).toMatchObject({
      transcriptText: '',
      items: [],
      moreToCheckCount: 0,
    })
    expect(calls.get(note.id)).toBeUndefined()
    await expect
      .poll(
        async () =>
          (
            await prisma.transcript.findFirstOrThrow({
              where: { noteId: note.id },
            })
          ).extractionStatus,
      )
      .toBe('COMPLETED')
  })

  it.each(['1', '2'])(
    'moves a return of %s from a confirmed leftover of two and preserves both rows',
    async (quantity) => {
      const source = await createJob(owner, 'Return source')
      const target = await createJob(owner, 'Return target')
      const { note } = await upload('workflow', source)
      const ready = await waitReady(note.id)
      const check = ready.items.find(
        (item: { item?: string }) => item.item === 'ply',
      )
      await looks(note.id, [check.queueItemId])
      const leftover = await prisma.memoryItem.findFirstOrThrow({
        where: { jobId: source, memoryType: 'LEFTOVER_MATERIAL' },
      })
      const result = await http(
        `/api/jobs/${source}/memory-items/${leftover.id}/return`,
        { body: { quantity }, status: 201 },
      )
      const returnedId = result.returnedItem.id
      // Legacy money on the returned row alone must block the entire move.
      const refund = await prisma.jobMoneyEvent.create({
        data: {
          jobId: source,
          kind: 'REFUND',
          direction: 'IN',
          amount: '5',
          occurredAt: new Date(),
          sourceMemoryItemId: returnedId,
        },
      })
      expect(await move(note.id, target, 409)).toMatchObject({
        code: 'NOTE_MOVE_BLOCKED',
      })
      expect((await draft(note.id)).jobId).toBe(source)
      expect(
        (
          await prisma.memoryItem.findUniqueOrThrow({
            where: { id: returnedId },
          })
        ).jobId,
      ).toBe(source)
      expect(await prisma.itemMove.count({ where: { noteId: note.id } })).toBe(
        0,
      )
      await prisma.jobMoneyEvent.delete({ where: { id: refund.id } })
      await move(note.id, target)
      const returned = await prisma.memoryItem.findUniqueOrThrow({
        where: { id: returnedId },
      })
      expect(returned).toMatchObject({
        jobId: target,
        quantity,
        returnedFromMemoryItemId: leftover.id,
      })
      expect(
        await prisma.reviewDecision.findUniqueOrThrow({
          where: { id: returned.reviewDecisionId },
        }),
      ).toMatchObject({
        jobId: target,
        action: 'ADD_MISSING',
      })
      expect(
        await prisma.memoryItem.findUniqueOrThrow({
          where: { id: leftover.id },
        }),
      ).toMatchObject({
        jobId: target,
        isRemoved: quantity === '2',
        quantity: quantity === '2' ? '2' : '1',
      })
      const returnedItems = async (jobId: string) =>
        (await http(`/api/jobs/${jobId}/memory-view`)).sections.find(
          (section: { key: string }) => section.key === 'returned_materials',
        ).items
      expect(await returnedItems(source)).toEqual([])
      expect(await returnedItems(target)).toContainEqual(
        expect.objectContaining({ id: returnedId }),
      )
    },
  )

  it('explains why a note checked together with another recording cannot move', async () => {
    const source = await createJob(owner, 'Shared decision source')
    const { note: a } = await upload('workflow', source)
    const { note: b } = await upload('workflow', source)
    await waitReady(a.id)
    await waitReady(b.id)
    const queue = await http(`/api/jobs/${source}/review-queue`)
    const item = queue.sections.find(
      (section: { key: string }) => section.key === 'ordered_materials',
    ).items[0]
    expect(item.kind).toBe('duplicate_group')
    await http(`/api/jobs/${source}/review-queue-decisions`, {
      body: { action: 'confirm', queueItemId: item.id },
    })
    expect(await move(a.id, second, 409)).toEqual({
      code: 'NOTE_MOVE_BLOCKED',
      message:
        "This note was checked together with another recording, so it can't be moved on its own.",
    })
  })

  it('files and moves owner-only photos, reports Home counts, and preserves the legacy note wrapper', async () => {
    const clientPhotoId = randomUUID()
    const form = () => {
      const data = new FormData()
      data.set(
        'file',
        new Blob(['image-bytes'], { type: 'image/jpeg' }),
        'photo.jpg',
      )
      data.set('clientPhotoId', clientPhotoId)
      data.set('captureContext', 'home')
      return data
    }
    const { photo } = await http('/api/photos', { body: form(), status: 201 })
    expect(photo).toMatchObject({
      jobId: null,
      filedAt: null,
      captureContext: 'home',
    })
    expect(await http(photo.fileUrl)).toBe('image-bytes')
    expect((await http('/api/photos', { body: form() })).photo.id).toBe(
      photo.id,
    )
    expect((await http('/api/unfiled')).photos).toContainEqual(
      expect.objectContaining({ photoId: photo.id }),
    )
    expect((await http('/api/unfiled', { user: stranger })).photos).toEqual([])
    await http(photo.fileUrl, { user: stranger, status: 404 })
    for (const action of ['file', 'move'])
      await http(`/api/photos/${photo.id}/${action}`, {
        user: stranger,
        body: { jobId: foreign },
        status: 404,
      })
    await http(`/api/photos/${photo.id}/file`, {
      body: { jobId: archived },
      status: 409,
    })
    expect(
      await http(`/api/photos/${photo.id}/file`, { body: { jobId: first } }),
    ).toMatchObject({ photo: { jobId: first } })
    expect(
      await http(`/api/photos/${photo.id}/move`, { body: { jobId: second } }),
    ).toMatchObject({ photo: { jobId: second } })
    expect((await http(`/api/jobs/${first}/photos`)).photos).toEqual([])
    expect((await http(`/api/jobs/${second}/photos`)).photos).toContainEqual(
      expect.objectContaining({ id: photo.id }),
    )
    const old = await http(`/api/jobs/${second}/notes`, {
      body: noteForm('empty'),
      status: 201,
    })
    expect(old).toEqual({
      noteId: expect.any(String),
      clientNoteId: expect.any(String),
      status: 'UPLOADED',
      isDuplicate: false,
    })
    await waitReady(old.noteId)
    expect(
      (await http('/api/home', { user: stranger })).inProgressJobs.map(
        (j: { id: string }) => j.id,
      ),
    ).toEqual([foreign])
    const home = await http('/api/home')
    expect(home).toMatchObject({
      otherJobs: { planningCount: 1, finishedCount: 1 },
      unfiledCount: 0,
      lastRecordedJobId: second,
    })
    expect(home.inProgressJobs.map((j: any) => j.id)).not.toContain(archived)
    const times = home.inProgressJobs.map((j: any) => j.lastActivityAt)
    expect(times).toEqual([...times].sort().reverse())
    for (const j of home.inProgressJobs) {
      const queue = await http(`/api/jobs/${j.id}/review-queue`)
      expect(j.toCheckCount).toBe(
        queue.sections.flatMap((s: any) => s.items).length,
      )
    }
  })
})
