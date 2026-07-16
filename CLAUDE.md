# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context & governance

This is the backend for **The Job Book**, a voice-first memory assistant for builders/tradespeople. `AGENTS.md` holds the working agreement with the tech lead — branch discipline, story/brief workflow, scope boundaries (non-goals), and the required handoff format. Read it before starting story work; the rules there override default behavior.

Active tech specs and briefs live **outside this repo** at `/Users/markgray/projects/the-job-book/the-job-book-project/tech`. The frontend is at `the-job-book-fe`.

## Commands

```bash
npm run dev          # tsx watch src/server.ts — local dev server (port 3000)
npm run build        # tsc → dist/
npm start            # node dist/server.js (run build first)

npm test                                  # vitest run (all tests)
npx vitest run tests/notes.upload.test.ts # single test file
npx vitest run -t "rejects oversized"     # single test by name
npm run test:watch                        # vitest watch mode

npm run db:migrate          # prisma migrate dev (create/apply migration locally)
npm run db:migrate:deploy   # prisma migrate deploy (CI/prod, no prompts)
npm run db:generate         # regenerate Prisma client after schema.prisma changes
npm run db:seed             # seed pilot user + job (tsx prisma/seed.ts)

npm run eval:extraction     # offline LLM extraction eval (fixtures → reports/)
npm run eval:speech-memory  # offline speech→memory eval
```

### Tests need a real Postgres database

Tests run against a **real DB**, not an in-memory fake (only storage/providers are faked). Create `.env.test` (gitignored) with a `DATABASE_URL` pointing at a throwaway local Postgres, and run migrations against it before testing. `tests/setup.ts` loads `.env.test`; vitest runs `singleFork` (serial) because tests share that database.

## Architecture

### The core pipeline (do not collapse it)

The central design constraint: preserve the boundary between evidence, AI interpretation, and trusted memory. The stages are distinct DB records, not one summary:

```
raw audio note → transcript → candidate facts → review decision → memory item
   (RawNote)     (Transcript)  (CandidateFact)  (ReviewDecision)  (MemoryItem)
```

Candidate facts are **draft AI output**, never trusted until the pilot confirms/corrects them via the review APIs. AI outputs carry confidence labels and `uncertaintyFlags`; approximate language ("about half a box") must not be forced into false precision, and contradictions/duplicates are surfaced for review rather than auto-resolved.

### Request → background processing flow

`src/app.ts` (`buildApp`) wires Fastify: CORS, cookie, multipart, the auth plugin, and all route plugins. It accepts injectable `storage` / `transcription` / `extraction` providers — this is the seam tests use to pass fakes. `src/server.ts` is the thin entrypoint that validates prod config and listens.

After a note upload succeeds, the route fires the worker **in-process** via `setImmediate` (`src/routes/notes.ts`) — there is no external queue runner in the request path. The chain is:

1. `runTranscription` (`src/transcription/worker.ts`) — creates a `Transcript`, drives `RawNote.serverStatus` through `UPLOADED → TRANSCRIBING → TRANSCRIBED` (or `FAILED`), then…
2. …calls `runExtraction` (`src/extraction/worker.ts`) — sets `extractionStatus`, runs the provider, applies `applyPilotCorrectionGuard`, and writes `CandidateFact` rows inside a `$transaction` (deletes prior facts for the transcript first, so re-runs are idempotent).

On failure the raw note and audio object are **preserved**; only status fields change. Extraction failure returns the note to `TRANSCRIBED` (not `FAILED`) to distinguish it from transcription failure.

### Provider adapters (config-driven, faked in tests)

Three swappable provider interfaces, each with a `create*Provider()` factory selecting an implementation by env var:

- **storage** (`src/storage/`) — `local` (default, writes to `LOCAL_AUDIO_DIR`) or `r2`. Audio is never exposed via public URLs.
- **transcription** (`src/transcription/`) — `fake` (deterministic, default) or `openai` (Whisper). Selected by `TRANSCRIPTION_PROVIDER`.
- **extraction** (`src/extraction/`) — fake vs `openai`, candidate-fact extraction from transcript text.

Always use deterministic fake providers in tests; real integrations sit behind config. Provider/model/schema-version metadata is persisted on transcript, extraction, and fact records.

### Layering convention

`routes/*` (HTTP: validation, status codes, auth) → `services/*` (domain logic, Prisma queries) → `db/client.ts` (shared Prisma client). Routes are Fastify plugins registered in `app.ts`. Each major resource follows this pair: `jobs`, `notes`, `facts`, `review`, `review-queue`, `memory-view`, `memory-items`, `inspection`.

### Reconciliation / review queue

`src/services/review-queue.ts` groups candidate facts into proposed memory sections (ordered/used/leftover materials, supplier notes, customer changes, watch-outs, unclear). Group IDs are **deterministic** SHA-256 hashes of `jobId` + sorted source fact IDs, so re-fetching the queue never invalidates an in-flight decision request. Note (per `memory/`): `GET /memory-view` is **not read-only** — it calls the fresh-queue builder which writes `queue_items`.

### Data model

`prisma/schema.prisma` is the source of truth. Core domain fields are relational; JSON is used only for variable metadata and schema-versioned provider payloads. Key models: `User`, `Job`, `RawNote`, `AudioObject`, `Transcript`, `CandidateFact`, `ReviewDecision`, `MemoryItem`, `QueueItem`. `MemoryItem` preserves source links back to candidate facts → transcripts → raw notes.

### Auth

Minimal pilot auth via `src/plugins/auth.ts`: the `X-Pilot-User-Id: <uuid>` header (must exist in `users`) or the `PILOT_USER_ID` env default. `routes/auth.ts` is registered **before** the auth plugin so login/logout bypass it.

## Conventions

- TypeScript ESM throughout — **imports use `.js` extensions** even for `.ts` source files (e.g. `import { prisma } from '../db/client.js'`). Match this.
- Idempotent note upload keys on `clientNoteId`: new note → `201`, duplicate → `200`. Must be safe under retries and concurrent duplicates. Store audio **before** the DB commit; on DB failure, clean up the stored object or return a clean idempotent result.
- Stable error codes live in `src/types/errors.ts` and are returned as `{ code, message }` (e.g. `AUDIO_UNSUPPORTED_TYPE` 415, `AUDIO_TOO_LARGE` 413). The multipart size-limit error is remapped to `AUDIO_TOO_LARGE` in the global error handler.
- Accepted upload type is `audio/webm` (incl. `;codecs=opus`); max 25 MB (below OpenAI's 26 MB limit). The submitted MIME type is preserved.
- Test HTTP routes at the wire level (status, body shape, auth, multipart) since the frontend consumes these contracts. If a response diverges from the tech spec, update the spec/brief before treating the work as done.
</content>
</invoke>
