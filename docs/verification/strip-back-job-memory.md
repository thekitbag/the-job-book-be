# Strip back to job memory: verification, 22 November 2026

Branch: `job-memory/strip-back-backend`. Base: `release/job-memory`, created and
pushed from `origin/main` at `4e84289629f3fa592db15165136941050e219b7e`.
No schema changes or migrations. No money data changes or backfills.

## Extraction comparison

The unmodified prompt and domain context were saved from the base commit, and
both versions were evaluated with `gpt-4o`, temperature 0, on the same 32 synthetic
fixtures. The fixture set is the original 28 plus four cases for a price-laden
material with first-person hours, several named people with a rate, first-person
hours alone, and a price-only hire note. Comparison now checks labour hours and
person as well as materials, quantities and suppliers.

Before modifying the prompt, the existing offline fake harness was run on both
the original and expanded fixtures. Its constant canned output fails every
fixture (28/28, then 32/32); it is a pipeline fake, not an extraction accuracy
measurement. Offline field scores were unchanged by removing its cost fields.

The real baseline used the original provider module, recovered from the base
commit, after a key became available. Final after-run scores on retained fact
types are:

| Field | Before | After |
|---|---:|---:|
| Material name | 16/19 | 17/19 |
| Quantity | 14/14 | 14/14 |
| Supplier | 4/4 | 4/4 |
| Labour hours | 6/6 | 6/6 |
| Labour person | 5/6 | 6/6 |

The denominator excludes expected facts of the intentionally removed note types;
this is the same subset of the same fixtures in both runs. The full unfiltered
scores are material name 17/21 → 17/21, quantity 14/14 → 14/14, supplier 6/6 → 4/6,
hours 6/6 → 6/6 and person 5/6 → 6/6. The two omitted supplier results belonged to
removed `supplier_delivery_note` expectations, rather than retained materials.

Raw fixture statuses: before 17 pass / 10 needs review / 5 fail; after 17 pass /
4 needs review / 11 fail. Ten after failures concern deliberately removed note
expectations (including one mixed fixture whose materials remain); one is the
pre-existing vague `unclear-001` miss in both versions. The original expectations
were retained so these differences remain visible. The new price-only fixture
returns no facts; the mixed price/person fixture returns three, with no money.
All final provider output uses only the six permitted fact types and has no £ or
quid in summaries. Worker tests independently check guarding provider money.

An intermediate prompt lost Workshop material context; another represented rough
quantities differently. Prompt rules were refined and the full same-fixture eval
rerun. The final prompt retains Workshop materials, separates numeric quantities
from units, preserves rough phrases and resolves first person to null.

Saved local artifacts (ignored generated output):

- `reports/extraction-eval/strip-back-before-original.md`
- `reports/extraction-eval/strip-back-before.md`, `strip-back-after.md` (fake)
- `reports/extraction-eval/strip-back-real-before.{md,json}`
- `reports/extraction-eval/strip-back-real-after.{md,json}`

These are measurements on synthetic fixtures, not proof of field accuracy on
Mike's recordings. No pilot audio or production database was used.

## HTTP and regression checks

`npm test`: **1,318 passed, 20 skipped**, 57 files passed / 2 skipped. Existing
skips are superseded labour contracts, not new missing verification.

`npm run build`: **pass**. `git diff --check`: **pass**.

`npm audit --audit-level=high`: **fails with 13 inherited findings**, 9 high,
2 moderate, 2 low. The same findings were verified against the unchanged base
using its package/lock files. They include Fastify/busboy/fast-uri, Prisma/effect,
Vitest/Vite/source-map-js, AWS XML dependencies and zod. No dependency changes are
included; dependency remediation needs separate review, including zod's major
upgrade. This is a review/release follow-up.

`npm test -- --run tests/job-memory.http.test.ts`: **12 pass**. Real database,
fake object storage and deterministic extraction. The suite exercises auth,
ownership, primary validation errors, receipt file download, money-off scans,
storage preservation, hours, materials, queue, log and export CLI.

`JOB_MEMORY_BASELINE_APP=/private/tmp/job-memory-main/src/app.ts npm test -- --run tests/job-memory.http.test.ts`:
**12 pass**. The temporary application was archived from unchanged `origin/main`.
With the money gate on, every listed builder read model matches the old
application on the same money-heavy fixture, excluding only `generatedAt`.

The base's supplier source-date suite independently reproduced three failures:
its "legacy undated" fixture was creating a new purchase, which now defaults to
the captured day. The fixture now explicitly seeds its historical null date.
No supplier-payment implementation was changed.

Functional check:

- Tool: real Fastify routes, HTTP injection plus fetch to a listening local server.
- Environment: local test PostgreSQL; synthetic money-heavy fixture; fake storage.
- Path: backend workflow steps 1–7, all **pass**:
  1. No money keys or £ in every listed builder read model.
  2. All money route groups disabled; support money still readable.
  3. Price-laden material plus two people produces three money-free checks;
     first person confirms without a LabourPerson link; transcript stays verbatim.
  4. Price-only hire produces no fact and remains in the log.
  5. Manual hours, material create/edit, legacy cost columns unchanged.
  6. Restored money values unchanged; direct old-application comparison also passes.
  7. Six CSV counts equal database counts; read-only export makes no DB writes;
     actual CLI emits only row counts.
- Extraction in the local HTTP check is deterministic. The real OpenAI extraction
  runs above cover the same utterances separately.
- Viewport/device: backend-only; no manual phone or browser check performed.
- Not checked by this backend workflow: production deployment, real pilot audio/device.

## Integrated frontend smoke

`node /private/tmp/backend-job-memory-integration.cjs`: **pass** against the running
`job-memory/strip-back-frontend` and backend branches, real local API at
`https://localhost:5175` → `http://localhost:3002`. Playwright Chromium, 390×844.
A separate synthetic account/job was created through signup, with no production
data or changes to the frontend worktree.

Path: open job → Hours → add Kurt, 21 November, 6 hours → total refreshes to 6h;
Materials → edit OSB supplier to Selco → save → create used Cement with rough
amount; Job log → typed note retains its £240 wording. Real server IDs and saved
values were checked against the API, the money endpoint returned 404 and no
browser errors occurred. Screenshot and API evidence are saved under
`/private/tmp/backend-job-memory-evidence/`. The synthetic local job is
`eebc3054-b911-4a5b-9876-e3383ce0504d`, retained for review. No physical-device or
production smoke was performed.

## Operational and contract notes

Default off: `MONEY_FEATURES_ENABLED`. Recognised true values: true/1/yes/on,
case-insensitive with surrounding whitespace ignored. Support and inspection
bypass the builder projection. Restoring money does not change extraction:
revert the v3 prompt/schema as well if restoring cost extraction is wanted.

Material display aliases are additive to the retained non-money item fields.
Hours is `memoryView.hours`, not the old labour money summary. Gate-on reads keep
the old shapes exactly. The existing notes upload contract has not changed.

Builder source-context excerpts have money phrases redacted in the listed read
models to satisfy their no-£ contract. Stored transcripts and Job log text remain
verbatim. Frontend should use `/log` for the builder's original words.

Typed log `at` uses happenedAt, falling back to createdAt. Photos use uploadedAt;
voice notes use capturedAt. Latest completed transcript revision wins, including
when a newer revision is still pending/failed. There is no log pagination.

CSV files preserve history, including soft-removed rows. Supplier payments can
span jobs, so their job titles/IDs are joined per payment. Formula-leading text
is escaped for spreadsheet safety. New output directories are recommended;
existing CSVs are not overwritten.

No Slice 2 work, frontend work, release merge or production deployment is included.
