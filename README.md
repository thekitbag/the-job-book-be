# the-job-book-be

Backend for **The Job Book** — a voice-first memory assistant for builders/tradespeople. It captures raw audio site notes, transcribes them, extracts draft candidate facts, and turns pilot-reviewed decisions into trusted job memory (hours, materials and the job log). Historical money remains stored behind an explicit backend gate.

The pipeline deliberately keeps evidence, AI interpretation, and trusted memory separate:

```
raw audio note → transcript → candidate facts → review decision → memory item
```

## Run locally

```bash
cp .env.example .env
# Edit DATABASE_URL to point at a local Postgres instance (e.g. jobbook_dev)
npm install
npx prisma migrate dev
npx prisma db seed
npm run dev
```

Server starts on `http://localhost:3000`. Health check: `GET /health`.

## Databases: `.env` vs `.env.test`

The app and the test suite use **two separate Postgres databases**:

| File | Used by | Purpose |
|---|---|---|
| `.env` | `npm run dev`, prisma CLI | Local dev database (e.g. `jobbook_dev`) |
| `.env.test` | `npm test` (loaded by `tests/setup.ts`) | Throwaway test database (e.g. `jobbook_test`) |

Both files are gitignored. Keep them pointing at **different** databases — several test suites write to and clean up the test database, and would destroy dev data if pointed at it.

Note: an exported `DATABASE_URL` in your shell overrides `.env` (Prisma only auto-loads `.env` for variables not already set). If the dev server seems to be talking to the wrong database, check `echo $DATABASE_URL` in the terminal running it.

Apply migrations to each database:

```bash
npx prisma migrate dev                                    # dev DB (from .env)
set -a; source .env.test; set +a; npx prisma migrate deploy   # test DB
```

## Tests

```bash
npm test
```

Tests need a **real Postgres database**: create `.env.test` with a `DATABASE_URL` pointing at a throwaway local database and run migrations against it first (see above). Vitest runs serially (`singleFork`) because suites share that database.

Two styles of test coexist:

- **Mocked-prisma HTTP tests** (most route suites, `tests/review-queue/`, `tests/memory-view/`) — mock `src/db/client.js` and assert wire-level behaviour. Shared builders live in `tests/helpers/`.
- **Real-DB tests** (`tests/auth-accounts.http.test.ts`, `tests/ownership.isolation.http.test.ts`, `tests/pilot-user-migration.test.ts`, and others) — exercise the app against the test database and clean up their own rows.

External providers are always faked in tests: no storage, transcription, extraction, or email API calls.

Standard verification before handing work back:

```bash
npm test
npm run build
npm audit --audit-level=high
```

## Required environment variables

Core local dev:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `SESSION_COOKIE_SECRET` | dev placeholder | HMAC secret for session cookies (must be set, ≥32 chars, in production) |
| `PILOT_USER_ID` | — | Dev/test only: fallback auth identity (ignored in production) |
| `AUDIO_STORAGE_PROVIDER` | `local` | `local` or `r2` (r2 required in production) |
| `LOCAL_AUDIO_DIR` | `./audio-store` | Where local audio files are stored |
| `TRANSCRIPTION_PROVIDER` | `fake` | `fake` (deterministic, no API call) or `openai` |
| `EXTRACTION_PROVIDER` | `fake` | `fake` or `openai` |
| `OPENAI_API_KEY` | — | Required when a provider is `openai` |
| `EMAIL_PROVIDER` | `dev` | `dev` (logs password-reset URLs) or `resend` |
| `FRONTEND_ORIGIN` / `CORS_ORIGIN` | `https://localhost:5173` | Allowed frontend origin(s), comma-separated |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `MONEY_FEATURES_ENABLED` | `false` | Explicit restore gate for builder money routes and fields. Off unless `true`/`1`/`yes`/`on`; support money reads remain available. No schema change. |
| `SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED` | `false` | Backend feature gate for supplier account settlement writes. Off unless set to a truthy value (`true`/`1`/`yes`/`on`); the write routes then return `403 SUPPLIER_SETTLEMENT_DISABLED`. Requires `MONEY_FEATURES_ENABLED=true` too; the money gate otherwise returns `404 FEATURE_DISABLED` for all builder Book Money routes. |

Production requires more (R2 credentials, Resend key/from address, `PASSWORD_RESET_URL_BASE`, `INTERNAL_INSPECTION_KEY`, …) and is validated at startup — see `src/config/production.ts` for the authoritative list.

## Auth

Account auth is email/password with an HttpOnly session cookie (`jobbook_session`):

- `POST /api/auth/signup` · `POST /api/auth/login` · `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/password-reset/request` · `POST /api/auth/password-reset/confirm`

In dev/test only, the `X-Pilot-User-Id: <uuid>` header (or the `PILOT_USER_ID` env var) can authenticate directly; production accepts session cookies only. Internal cross-user inspection requires an `INTERNAL`-role user **and** the `X-Internal-Inspection-Key` header.

## API surface

Route families (all under `/api`, job routes scoped to the authenticated owner):

- `jobs` — list/current/create/get
- `jobs/:jobId/notes` — idempotent multipart audio upload (`audio/webm`, max 25 MB), list/get, transcript
- `jobs/:jobId/facts`, `notes/:noteId/facts` — candidate facts
- `jobs/:jobId/review-queue`, `review-queue-decisions` — grouped review queue and confirm/correct/dismiss decisions
- `jobs/:jobId/memory-view` — trusted memory sections, cost/labour summaries
- `jobs/:jobId/memory-items` — direct add, patch, verify
- `jobs/:jobId/budget-categories`, `budget-summary` — budgets and known spend
- `internal/pilot/jobs/:jobId/inspection` — deliberate internal inspection

Errors are returned as `{ code, message }` with stable codes from `src/types/errors.ts` (e.g. `AUDIO_UNSUPPORTED_TYPE` 415, `AUDIO_TOO_LARGE` 413, `FORBIDDEN` 403).

Route handlers live in `src/routes/`, domain logic in `src/services/` — tests assert the wire-level contracts the frontend consumes.

## Operational scripts

| Command | Purpose |
|---|---|
| `npm run pilot:prepare` | Guarded pilot clean-starting-state tool (dry-run default) |
| `npm run migrate:pilot-user` | Guarded conversion of the pilot user to a real account (dry-run default; see `docs/auth-live-migration-runbook.md`) |
| `npm run eval:extraction` / `eval:speech-memory` | Offline LLM evaluation harnesses |

Audio files are never exposed via public URLs.

## Job memory release slice

The strip-back implementation targets `release/job-memory`, and releases together
with Slice 2. Leave `MONEY_FEATURES_ENABLED` unset or false for the memory-only
builder contract. Turning it on restores the historical builder read shapes and
money routes; restoring extraction also requires reverting the prompt/schema.

`GET /api/jobs/:jobId/memory-view` adds `hours` and material display fields with
money off. `GET /api/jobs/:jobId/log` returns `{ entries }` containing `voice_note`,
`typed_note` and `photo` entries, newest first. Recordings keep their original
transcript words, including prices; failed and pending recordings stay visible.

Manual material create requires `memoryType`, `materialName` (120 characters)
and free-text `quantity` (60), plus optional `supplierName` (80) and
`locationOrUse` (200). The server sets today's Europe/London date and `unit=null`.
Patch accepts the same fields; sending the existing amount leaves quantity/unit
untouched. Manual hours require `labourPerson` (60), decimal `labourHours` greater
than zero and at most 24, and optional `happenedAt` as a non-future YYYY-MM-DD
(default today in Europe/London). Money fields in cached write requests are ignored.

Founder export, with `DATABASE_URL` pointing at the intended database:

```bash
npm run export:money -- --user <userId> --out /private/tmp/jobbook-money-export
```

The script loads `.env`, reads in a repeatable-read, read-only transaction, and
writes six CSVs: `budget-categories`, `costed-memory-items`, `labour-with-cost`,
`customer-payments`, `money-events`, `supplier-payments`. Files include job titles
and stored dates, including removed/deleted historical rows. Existing files are
not overwritten; rerun into a fresh directory. The script prints only row counts
(use `npm run --silent export:money` to suppress npm's own banner).

Verification: `npm test -- --run tests/job-memory.http.test.ts` uses a real test
database and starts a local HTTP listener for the seven-step backend workflow.
It uses deterministic extraction; the real-provider comparison is documented in
`docs/verification/strip-back-job-memory.md`. Eval reports under
`reports/extraction-eval/` remain ignored, including raw model JSON.
