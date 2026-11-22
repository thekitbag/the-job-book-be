# Record from Home backend verification

Branch `job-memory/record-from-home-backend`, based on `release/job-memory` at
`17c42c9`. Run locally with the usual PostgreSQL configuration, then
`npm run db:generate`, `npm run db:migrate:deploy` and `npm run dev`.
The default providers are deterministic fakes. Real providers use
`TRANSCRIPTION_PROVIDER=openai`, `EXTRACTION_PROVIDER=openai` and
`OPENAI_API_KEY`.

## Migration

`20261122190000_record_from_home` makes note and photo job IDs nullable,
backfills recording ownership from jobs and sets historical filing times from
creation times. It adds capture context, owner-scoped retry keys, an item move
audit table and the `NOTE_LOOKS_RIGHT` decision action. It preserves both
job foreign keys and uses one SQL transaction. No money rows are migrated.
The old job note upload wrapper preserves its multipart and response contract.

A separate local PostgreSQL database was created with the previous migration
chain and seeded with two notes and one photo. Two notes in different jobs with
the same owner and client ID caused the migration to abort with its explicit
duplicate error. After changing the synthetic duplicate ID, migration deploy
succeeded and verified all **2 notes and 1 photo** were backfilled. The existing
local test database migration also passed, with **22 notes and 5 photos**
matching the backfill. No production data was required. Schema comparison found
only the pre-existing unused PostgreSQL enum `LabourBudgetTreatment`.

## Query audit

| Location | Queries and unfiled behavior |
|---|---|
| `services/notes.ts` | Upload and concurrent-winner lookup use owner + client ID and intentionally include unfiled notes. List, detail and transcript each constrain `jobId` to the requested owned job. Filing locks the owner-scoped row and writes its job and filing timestamp. |
| `services/capture-home.ts` | Unfiled note list/count and photo list/count require owner + null job. Home activity uses the owned job's note and photo relations. Most recently filed note requires a non-archived owned job relation and a filing date. |
| `services/capture-notes.ts` | Draft lookup uses note ID + owner and includes unfiled notes. Looks right and move lock the note by owner. Move updates only the locked note and photos linked to it or its moved memory on the old job. |
| `services/capture-photos.ts` | Upload and concurrent winner lookups use uploader + client photo ID. File/move lock the uploader-owned, non-deleted PHOTO. File serving uses photo ID + uploader and includes unfiled photos. |
| `services/capture-ownership.ts` | Locks a raw note by owner and ID before write transactions read or mutate it. |
| `services/photos.ts` | Link validation, list, file lookup, edit lookup and remove lookup constrain the requested job. Creates specify job and filing time. Edits and deletes update only the previously scoped ID. |
| `services/receipts.ts` | Creates specify job and filing time. List, file, edit and delete lookups constrain the job and receipt kind. Edits and deletes update only the previously scoped ID. |
| `services/job-log.ts` | Recording and non-deleted photo lists constrain the requested job. Linked photo relation descends from those recordings. |
| `services/facts.ts`, `services/inspection.ts` | Note fact lookup and inspection note list constrain the requested owned job. |
| `services/support.ts` | Note activity group-by now explicitly excludes null jobs. Support job note counts and photo lookup use the job relation or owned-job predicate. Photo aggregation guards the nullable ID. |
| `services/pilot-prepare.ts`, `services/pilot-user-migration.ts` | Note selection, deletion and counts already constrain specific job IDs or the owned job relation. Audio and transcript counts inherit that relation. |
| `transcription/worker.ts`, `extraction/worker.ts` | Internal worker note reads/writes use a previously resolved note ID. Transcription intentionally includes unfiled notes. Extraction checks filing before its atomic claim and rereads the job under a note row lock when publishing facts. |

## Local HTTP run

`CAPTURE_WORKFLOW_EVIDENCE=/tmp/record-home-http-evidence.jsonl npm test -- tests/record-from-home.http.test.ts`
uses a listening Fastify server, local PostgreSQL, test storage and deterministic
providers. IDs below are replaced with readable placeholders and extra fields
are omitted.

| Check | Observed response |
|---|---|
| Upload unfiled | 201 `{"note":{"id":"N","jobId":null,"filedAt":null,"captureContext":"home","serverStatus":"UPLOADED"}}` |
| List unfiled after transcription | 200 `{"notes":[{"noteId":"N","transcriptStatus":"completed","text":"workflow"}],"photos":[]}`. No extraction call. |
| File | 200 `{"note":{"id":"N","jobId":"A","filedAt":"<timestamp>"}}` |
| Poll draft | 200 `{"state":"ready","items":[{"kind":"hours","person":"Mike","hours":"6","uncertain":false},{"kind":"material","item":"OSB","amount":"3 sheets","uncertain":true}],"moreToCheckCount":0}` (third item omitted). |
| Looks right and retry | 200 `{"confirmed":["hours-id","osb-id"],"alreadyDecided":[]}`. Retry of hours returned `{"confirmed":[],"alreadyDecided":["hours-id"]}`. |
| Hours after confirmation | 200 `{"totalHours":"6","stillToCheck":1}` (trimmed memory-view). |
| Move | Legacy budget link returned 409 `{"code":"NOTE_MOVE_BLOCKED"}`. After clearing the synthetic link, 200 `{"note":{"id":"N","jobId":"B"}}`. Source hours/checks 0/0, target 6/1. Corrected quantity, pending state, linked photo, Workshop availability and audit were checked in the database. |
| Photo lifecycle | Upload 201 `{"photo":{"id":"P","jobId":null,"fileUrl":"/api/photos/P/file"}}`. File/move 200 with job A/B, duplicate upload 200, owner file GET 200, other user GET 404. |
| Original note route | 201 `{"noteId":"N2","clientNoteId":"C2","status":"UPLOADED","isDuplicate":false}`. Draft reaches ready. |
| Changed draft | 409 `{"code":"DRAFT_CHANGED"}` after a single joined a group, with no memory written. Foreign-note ID 400. Grouped-and-unclear draft returned `{"items":[],"moreToCheckCount":3}`. |

Home ordering, live review count versus job queue, owner isolation for new
routes, archived target, duplicate retries, and first/second filing trigger
orders were checked. Concurrent Looks right returned confirmed IDs once and
already-decided IDs on the other call. The post-confirm memory item retained
`approximate_quantity`.

## Latency

Ten sequential real-provider runs used a synthetic speech WebM generated
locally with macOS `say` and FFmpeg. Each POST supplied a selected job. Timing
started immediately before upload and ended when the draft first returned ready,
with 100 ms polling. Times in milliseconds were **3647, 2735, 2938, 4011,
2409, 2505, 2366, 2624, 2607, 2519**. The median was **2615.5 ms**.
This measures a local server with the existing OpenAI adapters and synthetic
audio, without a mobile network or time spent choosing the job.

`npm test`: 1,331 passed and 20 previously skipped. The money-unset profile:
931 passed and 54 restoration-only skips. `npm run build`, `git diff --check`
and `npm audit --audit-level=high` passed. The audit returned zero findings.

No frontend or physical-device smoke was run for this backend branch. The
frontend uses `moreToCheckCount`, `uncertain` and the 409 `DRAFT_CHANGED`
response to refresh stale drafts. Workers use in-process dispatch. Recovery scans on startup and every minute,
checking only the latest transcript revision of notes uploaded within seven days.
It redispatches missing, pending and over-five-minute work. Completed, failed
and fresh claims are skipped. A busy scan skips the next tick. Closing the
server clears the timer, stops dispatching queued recovery work and waits for
active work to finish. A note row lock and
timestamp claims prevent duplicate calls from startup and live triggers. A
superseded attempt cannot publish over the recovering attempt.

## Follow-up checks

- Partial and full returns move with their source leftover and their own
  `ADD_MISSING` decision, including when the leftover is soft removed. A refund
  event on the Returned row alone blocked the move and left both jobs unchanged.
- Silent uploads produced `{"state":"ready","transcriptText":"","items":[],"moreToCheckCount":0}`.
  Extraction reached completed without a provider call.
- Two local servers started against the same isolated PostgreSQL schema.
  Recovery processed three missing, pending or stuck transcriptions and five
  eligible extractions exactly once each, including a concurrent file request.
  Completed, failed, fresh and unfiled extraction states were checked. Silent
  completed transcription also recovered without a provider call.
- The shared-decision refusal uses the approved text.

- A real database HTTP regression test used a controlled clock to track a
  transcription claim that was ten seconds old at startup. The first five
  scans left it alone. The scan at minute five recovered it once. A blocked
  provider call prevented overlapping scans, and server close drained that
  call and stopped future ticks. Notes uploaded eight days earlier were not
  recovered in either stage. Filing an old unfiled note through HTTP still
  started extraction.
