// Real-DB tests for the guarded pilot-user conversion (dry-run default,
// single-row execute, refusal paths, post-write verification).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/db/client.js'
import { runPilotUserMigration } from '../src/services/pilot-user-migration.js'
import { verifyPassword } from '../src/lib/password.js'

const EMAIL_PREFIX = 'usermigration-'

let pilotUserId: string
let otherUserId: string
let jobId: string

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } })
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const jobs = await prisma.job.findMany({ where: { ownerUserId: { in: ids } } })
  const jobIds = jobs.map((j) => j.id)
  await prisma.memoryItem.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.reviewDecision.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.candidateFact.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.transcript.deleteMany({ where: { note: { jobId: { in: jobIds } } } })
  await prisma.rawNote.deleteMany({ where: { jobId: { in: jobIds } } })
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
}

beforeAll(cleanup)
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  const pilot = await prisma.user.create({
    data: { email: `${EMAIL_PREFIX}pilot@pilot.local`, name: 'Pilot', role: 'PILOT' },
  })
  pilotUserId = pilot.id
  const other = await prisma.user.create({
    data: { email: `${EMAIL_PREFIX}other@test.local`, name: 'Other' },
  })
  otherUserId = other.id

  const job = await prisma.job.create({
    data: { ownerUserId: pilotUserId, title: 'Live garden room', jobType: 'garden_room' },
  })
  jobId = job.id
  const note = await prisma.rawNote.create({
    data: { jobId, clientNoteId: randomUUID(), capturedAt: new Date(), mimeType: 'audio/webm', sizeBytes: 10 },
  })
  const tx = await prisma.transcript.create({ data: { noteId: note.id, status: 'COMPLETED', text: 'x' } })
  const fact = await prisma.candidateFact.create({
    data: {
      jobId,
      sourceNoteId: note.id,
      sourceTranscriptId: tx.id,
      factType: 'ORDERED_MATERIAL',
      summary: 's',
      confidenceLabel: 'HIGH',
      confidenceReason: 'r',
      uncertaintyFlags: [],
    },
  })
  const decision = await prisma.reviewDecision.create({
    data: { jobId, decidedBy: pilotUserId, action: 'CONFIRM', candidateFactId: fact.id },
  })
  await prisma.memoryItem.create({
    data: { jobId, reviewDecisionId: decision.id, memoryType: 'ORDERED_MATERIAL', summary: 's' },
  })
})

const MIKE_EMAIL = `${EMAIL_PREFIX}mike@real.example`

describe('runPilotUserMigration', () => {
  it('dry-run reports the planned conversion and counts without writing', async () => {
    const result = await runPilotUserMigration(
      { dryRun: true, pilotUserId, email: ` ${MIKE_EMAIL.toUpperCase()} `, name: 'Mike' },
      { prisma },
    )

    expect(result.dryRun).toBe(true)
    expect(result.pilotUser.id).toBe(pilotUserId)
    expect(result.plannedChanges.newEmail).toBe(MIKE_EMAIL)
    expect(result.plannedChanges.willSetPassword).toBe(false)
    expect(result.countsBefore).toMatchObject({
      jobs: 1, rawNotes: 1, transcripts: 1, candidateFacts: 1, reviewDecisions: 1, memoryItems: 1,
    })
    expect(result.countsAfter).toBeNull()

    const untouched = await prisma.user.findUnique({ where: { id: pilotUserId } })
    expect(untouched?.email).toBe(`${EMAIL_PREFIX}pilot@pilot.local`)
    expect(untouched?.passwordHash).toBeNull()
  })

  it('execute converts only the pilot user, preserving id and child data', async () => {
    const result = await runPilotUserMigration(
      { dryRun: false, pilotUserId, email: MIKE_EMAIL, name: 'Mike', tempPassword: 'temporary-password-1' },
      { prisma },
    )

    expect(result.verified).toBe(true)
    expect(result.countsAfter).toEqual(result.countsBefore)

    const converted = await prisma.user.findUnique({ where: { id: pilotUserId } })
    expect(converted?.email).toBe(MIKE_EMAIL)
    expect(converted?.name).toBe('Mike')
    expect(await verifyPassword('temporary-password-1', converted!.passwordHash!)).toBe(true)

    // Same user id — jobs and decisions still hang off it
    const job = await prisma.job.findUnique({ where: { id: jobId } })
    expect(job?.ownerUserId).toBe(pilotUserId)

    // The other user was not touched
    const other = await prisma.user.findUnique({ where: { id: otherUserId } })
    expect(other?.email).toBe(`${EMAIL_PREFIX}other@test.local`)
    expect(other?.passwordHash).toBeNull()
  })

  it('execute without tempPassword leaves passwordHash unset (reset flow)', async () => {
    const result = await runPilotUserMigration(
      { dryRun: false, pilotUserId, email: MIKE_EMAIL },
      { prisma },
    )
    expect(result.verified).toBe(true)
    const converted = await prisma.user.findUnique({ where: { id: pilotUserId } })
    expect(converted?.passwordHash).toBeNull()
  })

  it('refuses when the target email belongs to a different user', async () => {
    await expect(
      runPilotUserMigration(
        { dryRun: false, pilotUserId, email: `${EMAIL_PREFIX}other@test.local` },
        { prisma },
      ),
    ).rejects.toThrow(/already belongs to a different user/)
  })

  it('refuses when the pilot user id does not exist', async () => {
    await expect(
      runPilotUserMigration(
        { dryRun: true, pilotUserId: randomUUID(), email: MIKE_EMAIL },
        { prisma },
      ),
    ).rejects.toThrow(/not found/)
  })

  it('refuses an invalid target email', async () => {
    await expect(
      runPilotUserMigration({ dryRun: true, pilotUserId, email: 'not-an-email' }, { prisma }),
    ).rejects.toThrow(/valid email/)
  })
})
