# the-job-book-be

Backend for The Job Book — capture foundation (Stories 2-4).

## Run locally

```
cp .env.example .env
# Edit DATABASE_URL to point at a local Postgres instance
npm install
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

Server starts on `http://localhost:3000`. Health check: `GET /health`.

## Required environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `PILOT_USER_ID` | — | Seeded pilot user UUID; used as default auth identity |
| `STORAGE_MODE` | `local` | `local` only for now; S3 in a later brief |
| `LOCAL_AUDIO_DIR` | `./audio-store` | Where local audio files are stored |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin |
| `LOG_LEVEL` | `info` | |

## Object storage

Mode: `local` (files written to `LOCAL_AUDIO_DIR`).  
Audio files are not exposed via public URLs. No signed-URL support yet.

## Supported audio MIME types

| Type | Accepted |
|---|---|
| `audio/webm` | yes |
| `audio/webm;codecs=opus` | yes |
| `audio/webm; codecs=opus` | yes (normalised on store) |
| anything else | 415 AUDIO_UNSUPPORTED_TYPE |

Max upload size: **25 MB** (below OpenAI's 26 MB transcription limit).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/jobs/current` | Active pilot job for authenticated user |
| GET | `/api/jobs` | All jobs for user |
| GET | `/api/jobs/:jobId` | Single job |
| POST | `/api/jobs/:jobId/notes` | Upload raw audio note (multipart) |
| GET | `/api/jobs/:jobId/notes` | List notes for job |
| GET | `/api/jobs/:jobId/notes/:noteId` | Single note status |

### Auth

Minimal pilot auth: pass `X-Pilot-User-Id: <uuid>` header, or set `PILOT_USER_ID` env var.  
The header user must exist in the `users` table.

### Upload payload (multipart/form-data)

| Field | Type | Required |
|---|---|---|
| `clientNoteId` | string | yes |
| `capturedAt` | ISO 8601 string | yes |
| `mimeType` | string | yes |
| `audio` | file | yes |
| `durationMs` | number | no |

Returns `201` on new note, `200` on duplicate `clientNoteId` (idempotent).

### Error codes

| Code | Status |
|---|---|
| `AUDIO_UNSUPPORTED_TYPE` | 415 |
| `AUDIO_TOO_LARGE` | 413 |
| `JOB_NOT_FOUND` | 404 |
| `NOTE_NOT_FOUND` | 404 |
| `FORBIDDEN` | 403 |
| `MISSING_FIELD` | 400 |

## Tests

```
npm test
```

Tests use mocked Prisma and an in-process fake storage provider. No database needed.

## Frontend API contract notes

- `POST /api/jobs/:jobId/notes` returns `{ noteId, clientNoteId, status, isDuplicate }`.
- `isDuplicate: true` means the server already has this note; frontend should not re-enqueue processing.
- `status` is one of the `NoteStatus` enum values (`UPLOADED`, `QUEUED`, ..., `DONE`, `FAILED`).
- No public audio URLs are returned anywhere.
