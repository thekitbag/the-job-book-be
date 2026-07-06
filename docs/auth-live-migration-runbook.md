# Auth Live Migration Runbook (Backend)

Date: 2026-07-04
Scope: converting the live pilot user to Mike's real email/password account,
with backup and rollback preparation. **Production migration must not run
without completing the Backup section first.**

The operational cutover checklist (deploy order, freeze window, smoke test)
lives in the tech repo. This document covers the backend commands.

## Inputs (fill in before running anything)

- Mike's confirmed email address: `________`
- Password strategy: no temp password (Mike uses "Forgot password?") **[recommended]** or `--temp-password`
- Existing pilot user id (`PILOT_USER_ID` in production env): `________`
- Production `DATABASE_URL` host: `________`
- Object storage bucket (`R2_BUCKET`): `________`

## 1. Backup (before any production write)

### Database backup

```bash
# Record: timestamp, database name, command used, output file location
pg_dump "$DATABASE_URL" --format=custom --no-owner \
  --file "jobbook-prod-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Record in the migration log:

- backup file path and size
- UTC timestamp
- database host/name
- the exact command used

### Table counts before migration

```bash
psql "$DATABASE_URL" -c "
SELECT 'users' t, count(*) FROM users UNION ALL
SELECT 'jobs', count(*) FROM jobs UNION ALL
SELECT 'raw_notes', count(*) FROM raw_notes UNION ALL
SELECT 'audio_objects', count(*) FROM audio_objects UNION ALL
SELECT 'transcripts', count(*) FROM transcripts UNION ALL
SELECT 'candidate_facts', count(*) FROM candidate_facts UNION ALL
SELECT 'queue_items', count(*) FROM queue_items UNION ALL
SELECT 'review_decisions', count(*) FROM review_decisions UNION ALL
SELECT 'memory_items', count(*) FROM memory_items UNION ALL
SELECT 'job_budget_categories', count(*) FROM job_budget_categories;"
```

### Object-storage audio manifest

Audio bytes are not touched by this migration, but capture a manifest so a
mismatch can be detected after any restore:

```bash
# R2 is S3-compatible; endpoint/keys are the production R2_* env values
aws s3 ls "s3://$R2_BUCKET" --recursive --summarize \
  --endpoint-url "$R2_ENDPOINT" > "r2-manifest-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

Record object count and total size; cross-check the object count against the
`audio_objects` row count.

## 2. Rehearsal (restore backup into a non-production DB, run migration there)

```bash
createdb jobbook_rehearsal
pg_restore --no-owner --dbname "postgresql://localhost/jobbook_rehearsal" jobbook-prod-<ts>.dump

DATABASE_URL="postgresql://localhost/jobbook_rehearsal" \
  npm run migrate:pilot-user -- \
  --target staging --expect-db-host localhost \
  --user-id <pilot-user-id> --email <mike-email>            # dry-run first

DATABASE_URL="postgresql://localhost/jobbook_rehearsal" \
  npm run migrate:pilot-user -- \
  --target staging --expect-db-host localhost \
  --user-id <pilot-user-id> --email <mike-email> --execute
```

Verify against the rehearsal DB: login works (or reset flow), jobs/notes/memory
counts match the pre-migration counts, a fresh signup sees none of Mike's data.

## 3. Production migration

Dry-run first, then execute. `--expect-db-host` must be a substring of the
production DB host; the script refuses to run otherwise.

```bash
npm run migrate:pilot-user -- \
  --target production --expect-db-host <prod-db-host> \
  --user-id <pilot-user-id> --email <mike-email> [--name "Mike"]

npm run migrate:pilot-user -- \
  --target production --expect-db-host <prod-db-host> \
  --user-id <pilot-user-id> --email <mike-email> [--name "Mike"] --execute
```

The script prints planned changes and child-data counts, performs a single-row
update keyed by the pilot user id, then verifies the converted row and that all
child-data counts are unchanged (non-zero exit on failure).

With no `--temp-password`, Mike logs in via **Forgot password?** using his
confirmed email (requires production Resend config to be live).

## 4. Rollback

Decision owner: founder/tech lead. Trigger: post-migration smoke test fails in
a way that indicates data damage (not a config-only issue).

### Database restore

```bash
# Restores the pre-migration backup over the production database.
pg_restore --clean --if-exists --no-owner \
  --dbname "$DATABASE_URL" jobbook-prod-<ts>.dump
```

Note: `--clean` drops and recreates objects; any writes made after the backup
are lost — hence the freeze/quiet window during cutover.

### Object storage

No audio objects are written or deleted by this migration. Verification after
restore: re-run the manifest command and compare object count/size against the
pre-migration manifest, and check `audio_objects` count matches.

### App rollback

Redeploy the previous backend (and frontend, if already cut over) builds via
the hosting provider's previous-deploy rollback. The old backend expects
`PILOT_PASSCODE`/`PILOT_USER_ID` env vars — do not remove them from the
production environment until the release is declared safe.

### Post-restore verification

- table counts match the recorded pre-migration counts
- pilot user row has the original email
- app health check passes; Mike can use the previous auth path

## 5. Post-migration

- confirm the production env no longer sets `PILOT_PASSCODE` (startup
  validation fails if it is set)
- run the post-migration smoke test from the tech-repo runbook
- keep the backup file and manifest until the release is declared safe
