import { execFileSync } from 'node:child_process'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { prisma } from '../src/db/client.js'
import { FakeAudioStorage } from './fakes/storage.js'

const isolated = vi.hoisted(() => {
  // The startup scan covers the whole database. Isolate it from local data
  // and the other HTTP suites, which run in parallel on the test database.
  const schema = 'restart_' + crypto.randomUUID().replaceAll('-', '')
  const url = new URL(process.env.DATABASE_URL!)
  url.searchParams.set('schema', schema)
  return { schema, url: url.toString() }
})
vi.mock('../src/db/client.js', async () => {
  const { PrismaClient } = await import('@prisma/client')
  return { prisma: new PrismaClient({ datasourceUrl: isolated.url }) }
})

const storage = new FakeAudioStorage()
const transcriptions: string[] = []
const extractions: string[] = []
const extractionBarriers = new Map<string, Promise<void>>()
const appOptions = {
  recoverOnStart: true,
  storage,
  transcription: {
    name: 'test',
    model: 'test',
    async transcribe(input: { noteId: string }) {
      transcriptions.push(input.noteId)
      return { text: 'Six hours on the roof' }
    },
  },
  extraction: {
    name: 'test',
    model: 'test',
    async extractFacts(input: { noteId: string }) {
      extractions.push(input.noteId)
      await extractionBarriers.get(input.noteId)
      return {
        schemaVersion: 'v3-job-memory',
        facts: [
          {
            factType: 'labour' as const,
            summary: 'Six hours on the roof',
            labourHours: '6',
            confidenceLabel: 'high' as const,
            confidenceReason: 'Stated',
            uncertaintyFlags: [],
          },
        ],
      }
    },
  },
}
const servers: ReturnType<typeof buildApp>[] = []
let owner: string, jobId: string
const stale = new Date(Date.now() - 6 * 60_000)
const fresh = new Date()

beforeAll(async () => {
  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: isolated.url },
      stdio: 'pipe',
    },
  )
  owner = (
    await prisma.user.create({
      data: { name: 'Mike', email: 'restart@example.test' },
    })
  ).id
  jobId = (
    await prisma.job.create({
      data: { title: 'Restart', jobType: 'garden_room', ownerUserId: owner },
    })
  ).id
}, 30_000)

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await prisma.$disconnect()
  const admin = new PrismaClient()
  try {
    await admin.$executeRaw(
      Prisma.sql`DROP SCHEMA IF EXISTS ${Prisma.raw('"' + isolated.schema + '"')} CASCADE`,
    )
  } finally {
    await admin.$disconnect()
  }
})

type TranscriptSeed = Omit<Prisma.TranscriptUncheckedCreateInput, 'noteId'>
async function seed(
  key: string,
  job: string | null,
  ...revisions: TranscriptSeed[]
) {
  const note = await prisma.rawNote.create({
    data: {
      jobId: job,
      ownerUserId: owner,
      clientNoteId: key,
      capturedAt: new Date(),
      mimeType: 'audio/webm',
      sizeBytes: 10,
      audioObject: {
        create: {
          storageKey: key,
          bucket: 'fake',
          mimeType: 'audio/webm',
          sizeBytes: 10,
        },
      },
    },
  })
  await storage.store(key, Buffer.from('audio'), 'audio/webm')
  for (const data of revisions)
    await prisma.transcript.create({ data: { ...data, noteId: note.id } })
  return note.id
}

it('recovers only eligible latest work on simultaneous startup and filing', async () => {
  const missing = await seed('missing-transcript', null)
  const pending = await seed('pending-transcript', jobId, { status: 'PENDING' })
  const stuck = await seed('stuck-transcript', jobId, {
    status: 'TRANSCRIBING',
    startedAt: stale,
  })
  const txFresh = await seed('fresh-transcript', jobId, {
    status: 'TRANSCRIBING',
    startedAt: fresh,
  })
  const txFailed = await seed(
    'failed-transcript',
    jobId,
    { status: 'PENDING', revision: 1 },
    { status: 'FAILED', revision: 2 },
  )
  const complete = { status: 'COMPLETED', text: 'Six hours' } as const
  const exMissing = await seed('missing-extraction', jobId, complete)
  const exPending = await seed('pending-extraction', jobId, {
    ...complete,
    extractionStatus: 'PENDING',
  })
  const exStuck = await seed('stuck-extraction', jobId, {
    ...complete,
    extractionStatus: 'EXTRACTING',
    extractionStartedAt: stale,
  })
  const exFresh = await seed('fresh-extraction', jobId, {
    ...complete,
    extractionStatus: 'EXTRACTING',
    extractionStartedAt: fresh,
  })
  const exDone = await seed('done-extraction', jobId, {
    ...complete,
    extractionStatus: 'COMPLETED',
  })
  const exFailed = await seed('failed-extraction', jobId, {
    ...complete,
    extractionStatus: 'FAILED',
  })
  const waitingForJob = await seed('unfiled-completed', null, complete)
  const silent = await seed('silent', jobId, { ...complete, text: '' })
  let release: () => void = () => {}
  extractionBarriers.set(
    exStuck,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  servers.push(buildApp(appOptions), buildApp(appOptions))
  const [base] = await Promise.all(
    servers.map((server) => server.listen({ host: '127.0.0.1', port: 0 })),
  )
  const headers = { 'x-pilot-user-id': owner }
  try {
    await expect
      .poll(() => extractions.filter((id) => id === exStuck).length)
      .toBe(1)
    const file = await fetch(base + `/api/notes/${exStuck}/file`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
    expect(file.status).toBe(200)
  } finally {
    release()
  }
  const recovered = [pending, stuck, exMissing, exPending, exStuck]
  const draft = async (id: string) =>
    (await fetch(base + `/api/notes/${id}/draft`, { headers })).json()
  await expect
    .poll(
      async () =>
        Promise.all(recovered.map(async (id) => (await draft(id)).state)),
      { timeout: 5000 },
    )
    .toEqual(Array(recovered.length).fill('ready'))
  await expect
    .poll(
      async () =>
        (await prisma.transcript.findFirst({ where: { noteId: missing } }))
          ?.status,
    )
    .toBe('COMPLETED')
  await expect
    .poll(
      async () =>
        (await prisma.transcript.findFirst({ where: { noteId: silent } }))
          ?.extractionStatus,
    )
    .toBe('COMPLETED')
  expect(transcriptions.sort()).toEqual([missing, pending, stuck].sort())
  expect(extractions.sort()).toEqual(recovered.sort())
  for (const id of recovered)
    expect(
      await prisma.candidateFact.count({ where: { sourceNoteId: id } }),
    ).toBe(1)
  expect(await prisma.transcript.count({ where: { noteId: missing } })).toBe(1)
  for (const [id, state] of [
    [txFresh, 'transcribing'],
    [txFailed, 'failed'],
    [exFresh, 'extracting'],
    [exDone, 'ready'],
    [exFailed, 'failed'],
    [waitingForJob, 'not_filed'],
    [silent, 'ready'],
  ]) {
    expect((await draft(id)).state).toBe(state)
  }
}, 15_000)

it('rechecks fresh work each minute and keeps old uploads out of recovery', async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  const now = Date.now()
  const abandoned = await seed('abandoned-at-start', jobId, {
    status: 'TRANSCRIBING',
    startedAt: new Date(now - 10_000),
  })
  const oldFiled = await seed('old-filed', jobId, {
    status: 'COMPLETED',
    text: 'Six hours',
  })
  const oldUnfiled = await seed('old-unfiled', null, {
    status: 'COMPLETED',
    text: 'Six hours',
  })
  const oldUntranscribed = await seed('old-untranscribed', jobId)
  const oldIds = [oldFiled, oldUnfiled, oldUntranscribed]
  await prisma.rawNote.updateMany({
    where: { id: { in: oldIds } },
    data: { uploadedAt: new Date(now - 8 * 24 * 60 * 60_000) },
  })

  // Hold extraction from the retry open across the next scan tick.
  let release: () => void = () => {}
  extractionBarriers.set(
    abandoned,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const query = vi.spyOn(prisma, '$queryRaw')
  const scans = () =>
    query.mock.calls.flatMap(([sql], index) =>
      Array.isArray(sql) && sql[0].includes('WITH recent_notes')
        ? [query.mock.results[index].value]
        : [],
    )
  const scanCount = () => scans().length
  async function waitForEmptyScan(count: number) {
    await expect.poll(scanCount).toBe(count)
    expect(await scans().at(-1)).toEqual([])
    // Let the scheduler settle its promise before advancing to the next tick.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(now)
  const app = buildApp(appOptions)
  servers.push(app)
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 })
    const headers = { 'x-pilot-user-id': owner }
    await waitForEmptyScan(1)
    const transcript = (id: string) =>
      prisma.transcript.findFirst({ where: { noteId: id } })
    expect((await transcript(abandoned))?.status).toBe('TRANSCRIBING')

    // At minute four the claim is 4m10s old. Step through each interval so
    // the database scan finishes before the next scheduled tick.
    for (let minute = 1; minute <= 4; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForEmptyScan(minute + 1)
      expect((await transcript(abandoned))?.status).toBe('TRANSCRIBING')
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await expect
      .poll(() => extractions.filter((id) => id === abandoned).length)
      .toBe(1)
    expect(transcriptions.filter((id) => id === abandoned)).toHaveLength(1)
    expect((await transcript(abandoned))?.status).toBe('COMPLETED')
    expect(scanCount()).toBe(6)

    // A tick while the recovery provider is still in flight does not rescan.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scanCount()).toBe(6)
    expect((await transcript(oldFiled))?.extractionStatus).toBeNull()
    expect(await transcript(oldUntranscribed)).toBeNull()
    expect(extractions.some((id) => oldIds.includes(id))).toBe(false)

    const file = await fetch(base + `/api/notes/${oldUnfiled}/file`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
    expect(file.status).toBe(200)
    await expect
      .poll(async () => (await transcript(oldUnfiled))?.extractionStatus)
      .toBe('COMPLETED')
    expect(extractions.filter((id) => id === oldUnfiled)).toHaveLength(1)

    // Close waits for the running recovery to publish, then clears the timer.
    let closed = false
    const closing = app.close().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(closed).toBe(false)
    release()
    await closing
    servers.pop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(scanCount()).toBe(6)
    expect((await transcript(abandoned))?.extractionStatus).toBe('COMPLETED')
  } finally {
    release()
    vi.useRealTimers()
    query.mockRestore()
  }
}, 15_000)
