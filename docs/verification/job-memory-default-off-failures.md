# Initial money-unset test failures and their resolution

The first broad run selected the non-money and mixed suites without changing their old expectations. It found **152 failed assertions across 14 files**. Production routes, services, providers and workers were not changed to make these tests pass. All changes are fixture, assertion, harness or CI changes.

Final result: **920 passed, 54 explicitly money-only assertions skipped, 0 failures, 41 files passed**. The full restoration run still executes the money assertions: **1,320 passed, 20 pre-existing skips, 0 failures**.

The 54 skips are restoration-only assertions within mixed files. Money-only files and the removed `labourHoursSummary` contract are excluded by the explicit Vitest profile. Current Hours, material add/edit/return, receipt-file, hidden historical money, queue and Job log contracts remain covered by the real-database job-memory suite. The profile also runs auth, ownership, uploads, transcription/extraction, photos, memory views, review decisions, Workshop and founder support.

| Initial failing file | Count | Reason |
|---|---:|---|
| direct-add.http.test.ts | 19 | Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates. |
| extraction.worker.test.ts | 14 | Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged. |
| memory-items.http.test.ts | 19 | Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again. |
| ownership.isolation.http.test.ts | 4 | The feature gate runs before auth on disabled money routes, so the expected result is 404 FEATURE_DISABLED rather than 401. All enabled routes still require auth and ownership. |
| remove-items.http.test.ts | 4 | Memory-view mocks lack the account-name query needed by Hours; remaining failures assert removed cost summaries, a gated budget route or clearing a historical budget link. The new profile asserts current hours and leaves money links untouched. |
| returned-materials.http.test.ts | 10 | Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours. |
| workshop.http.test.ts | 9 | Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses. |
| memory-view/memory-view.labour-hours.http.test.ts | 11 | These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run. |
| memory-view/memory-view.sections.http.test.ts | 12 | The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries. |
| memory-view/memory-view.summary-sections.http.test.ts | 15 | The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes. |
| review-queue/review-queue.decisions.http.test.ts | 10 | Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off. |
| review-queue/review-queue.labour.http.test.ts | 15 | Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration. |
| review-queue/review-queue.read-write-split.http.test.ts | 3 | Legacy assertions expect model summaries and deletion of stale draft rows. Money-off uses structured labels and preserves those rows for reversibility; reads remain write-free. |
| review-queue/review-queue.read.http.test.ts | 7 | Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags. |

## Every initial failed assertion

Status below is its result or selection in the final money-unset run. Restoration-only assertions remain executed in the full suite.

### direct-add.http.test.ts

- **POST /api/jobs/:jobId/memory-items — direct add creates trusted manual spend (ordered_material) with isManual and null source**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add creates an ADD_MISSING review decision with empty source facts**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add manual spend without cost is remembered but has no total**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add creates manual labour with happenedAt, person, hours and task**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add derives a per_hour labour total**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **POST /api/jobs/:jobId/memory-items — direct add creates manual used material with no cost total**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add creates a typed note (watch_out)**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items — direct add allows a category on ordered_material**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **POST /api/jobs/:jobId/memory-items — direct add rejects an archived category (400) and another-job category (404)**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **direct-add items in memory-view and budget-summary places a manual general_note in the general_notes section with source null**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **direct-add items in memory-view and budget-summary includes manual spend with a safe total in budget-summary**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation direct add derives a line total from quantity × each unit cost**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation direct add does not derive a total when the unit is missing**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation direct add flags a conflicting explicit total as cost_uncertain**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation patch omitting totalCostAmount recalculates from effective quantity × unit cost**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation patch with totalCostAmount:null clears the total rather than deriving**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **auto-total unit cost — direct add and patch derivation patch with a conflicting explicit total keeps it worth checking**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **labour happenedAt — create/patch day semantics clears happenedAt when the patch sends null**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

- **labour happenedAt — create/patch day semantics edits day, person, hours, and task together on patch**
  - Reason: Legacy add assertions use optional quantities, separate units, model summaries, typed watch_out creation, cost/category behavior or nullable/date-time labour dates. The current handwritten contracts require an amount, generate structured summaries, ignore money, create only general typed notes and require date-only hours dates.
  - Resolution: Pass with current-contract fixture/assertion.

### extraction.worker.test.ts

- **runExtraction — cost field persistence and safe total derivation persists cost fields and derives total from 8 × £5 each**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation derives total from non-integer unit cost: 12 × £8.50 = £102**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not derive total when qualifier is approx; preserves cost_uncertain flag**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation preserves provider-returned totalCostAmount for explicit total cost**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not derive total when quantity is "8 bags" (partial string)**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not derive total when quantity is "about 8" (text prefix)**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not derive total when costAmount is "5 each" (text suffix)**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not derive total when costAmount is "5-ish" (non-decimal)**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation adds cost_uncertain when quantity × costAmount conflicts with explicit totalCostAmount**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation does not add cost_uncertain when totals agree**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — cost field persistence and safe total derivation persists null cost fields for facts with no cost information**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **runExtraction — labour happenedAt (effective day) resolves a provider "yesterday" relative to the source note capture date**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Pass with current-contract fixture/assertion.

- **runExtraction — safe material total derivation does not derive a total when the unit is missing**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Pass with current-contract fixture/assertion.

- **runExtraction — safe material total derivation does not derive a total when the currency is missing**
  - Reason: Legacy v1 cost-field/total assertions expect persisted prices or null money keys. With money unset those keys are intentionally absent; date extraction itself is unchanged.
  - Resolution: Pass with current-contract fixture/assertion.

### memory-items.http.test.ts

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — validation returns 400 MISSING_FIELD when memoryType is absent**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — validation returns 400 INVALID_FIELD when costAmount is not a decimal string**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — validation returns 400 INVALID_FIELD when totalCostAmount is not a decimal string**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — validation returns 400 INVALID_FIELD when costQualifier is invalid**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — happy path persists cost fields when supplied**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — uncertaintyResolution still_unsure preserves existing unresolvedFlags**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — uncertaintyResolution omitting uncertaintyResolution preserves existing unresolvedFlags**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation auto-derives totalCostAmount from quantity × costAmount when qualifier is each**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation re-derives when quantity is updated**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation explicit totalCostAmount in patch is used when provided**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation adds cost_uncertain when explicit total conflicts with derived amount**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation derives totalCostAmount from a stated total price the client did not send**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation leaves no total when a corrected each-basis price is still ambiguous**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation preserves a legacy manual total when the patch does not touch the cost expression**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation removes cost_uncertain when derived total now matches stored total**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation uncertaintyResolution resolved does not clear cost_uncertain when conflict is present**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — cost recalculation does not derive when qualifier is not each**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — response labels includes unitCostLabel and lineTotalLabel in response**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **PATCH /api/jobs/:jobId/memory-items/:memoryItemId — response labels unitCostLabel is null when qualifier is not each**
  - Reason: Legacy edits require memoryType, validate/recalculate money or expect cost labels. Four-field edits allow omitted memoryType, ignore malformed money and omit hidden columns. Unchanged uncertainty flags are preserved by omitting the update rather than writing them again.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

### ownership.isolation.http.test.ts

- **cross-user isolation: user B against user A data unauthenticated list budget categories is rejected with 401**
  - Reason: The feature gate runs before auth on disabled money routes, so the expected result is 404 FEATURE_DISABLED rather than 401. All enabled routes still require auth and ownership.
  - Resolution: Pass with current-contract fixture/assertion.

- **cross-user isolation: user B against user A data unauthenticated create budget category is rejected with 401**
  - Reason: The feature gate runs before auth on disabled money routes, so the expected result is 404 FEATURE_DISABLED rather than 401. All enabled routes still require auth and ownership.
  - Resolution: Pass with current-contract fixture/assertion.

- **cross-user isolation: user B against user A data unauthenticated patch budget category is rejected with 401**
  - Reason: The feature gate runs before auth on disabled money routes, so the expected result is 404 FEATURE_DISABLED rather than 401. All enabled routes still require auth and ownership.
  - Resolution: Pass with current-contract fixture/assertion.

- **cross-user isolation: user B against user A data unauthenticated budget summary is rejected with 401**
  - Reason: The feature gate runs before auth on disabled money routes, so the expected result is 404 FEATURE_DISABLED rather than 401. All enabled routes still require auth and ownership.
  - Resolution: Pass with current-contract fixture/assertion.

### remove-items.http.test.ts

- **active reads exclude removed memory items memory-view queries only non-removed items**
  - Reason: Memory-view mocks lack the account-name query needed by Hours; remaining failures assert removed cost summaries, a gated budget route or clearing a historical budget link. The new profile asserts current hours and leaves money links untouched.
  - Resolution: Pass with current-contract fixture/assertion.

- **active reads exclude removed memory items budget-summary queries only non-removed items**
  - Reason: Memory-view mocks lack the account-name query needed by Hours; remaining failures assert removed cost summaries, a gated budget route or clearing a historical budget link. The new profile asserts current hours and leaves money links untouched.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **active reads exclude removed memory items after removal, spend/labour totals recompute from active rows only**
  - Reason: Memory-view mocks lack the account-name query needed by Hours; remaining failures assert removed cost summaries, a gated budget route or clearing a historical budget link. The new profile asserts current hours and leaves money links untouched.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH on removed items and used ↔ leftover moves moves leftover → used and clears a stale budget category**
  - Reason: Memory-view mocks lack the account-name query needed by Hours; remaining failures assert removed cost summaries, a gated budget route or clearing a historical budget link. The new profile asserts current hours and leaves money links untouched.
  - Resolution: Pass with current-contract fixture/assertion.

### returned-materials.http.test.ts

- **POST return — partial return creates a returned item and reduces the source leftover quantity**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST return — Money in refund event creates one REFUND Money in event linked to the returned item for a trusted GBP refund**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **POST return — rejections (no mutation) invalid refund amount → 400**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **POST return — rejections (no mutation) non-GBP refund currency → 400**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **memory-view — Returned section and refund summary normalizes returned_material into the Returned section with refund fields**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Pass with current-contract fixture/assertion.

- **memory-view — Returned section and refund summary a trusted refund reduces net totalKnownCost while gross stays and a refund row shows**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **memory-view — Returned section and refund summary a returned item without a trusted refund does not reduce spend**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **memory-view — Returned section and refund summary non-GBP or flagged refunds are excluded from net spend**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **budget-summary — net known spend after refunds exposes net known spend and a refund adjustment; categories stay gross**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **budget-summary — net known spend after refunds no-refund returned item leaves net equal to gross**
  - Reason: Refund inputs/labels/events and money summaries belong to the restore contract. Money-off returns ignore refund values. The Returned read mock also lacked the account-name and linked-person lookups used by Hours.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

### workshop.http.test.ts

- **POST /api/jobs/:jobId/memory-items/:memoryItemId/workshop moves a confirmed leftover into the Workshop and leaves the source row visible**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items/:memoryItemId/workshop moves a Finished job leftover without changing the job status**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/memory-items/:memoryItemId/workshop leaves the source purchase, cost and paid state exactly as they were**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/workshop/items adds an item from a material name alone, with no job, source or finance fields**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **PATCH /api/workshop/items/:workshopItemId changes the rough amount on a source-linked item and shows it on the source row**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **Workshop lifecycle undoes a move, restoring the source to not moved with the latest wording**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **Workshop lifecycle marks all used up and wasn't there as two distinct, separately recorded outcomes**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **Workshop lifecycle leaves the source purchase untouched when material wasn't there after all**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

- **Workshop lifecycle puts a source-linked item back from both terminal states without duplicating it**
  - Reason: Legacy fixtures were created through the old money-bearing add API and the preservation snapshot called now-disabled money routes. Seed historical rows directly, compare stored money before/after every Workshop action, and assert money is absent from builder responses.
  - Resolution: Pass with current-contract fixture/assertion.

### memory-view/memory-view.labour-hours.http.test.ts

- **memory-view — labourHoursSummary returns an empty summary when the job has no labour memory**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary groups two labour items from the same day into one day with day and job totals**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary orders days newest first and item fields carry hours label and happenedAt**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary groups by the UK local calendar day, not the UTC day**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary falls back to the source note capture day when happenedAt is null**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary falls back to the created day for manual labour with no happenedAt**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary keeps non-numeric hours visible but excludes them from totals**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary keeps worth-checking labour visible but out of hour totals when the flags touch the hours**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary still counts hours when the only unresolved flag is cost_uncertain**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary supports fractional hours in totals**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

- **memory-view — labourHoursSummary exposes trusted line totals for rated labour and null for hours-only labour**
  - Reason: These assertions target the old labourHoursSummary wire model, which exists only with money enabled. The current memoryView.hours contract is tested by the real-database job-memory suite; this old-contract file remains in the restoration run.
  - Resolution: Old labourHoursSummary contract stays in restoration; current hours covered by the real-DB suite.

### memory-view/memory-view.sections.http.test.ts

- **GET /api/jobs/:jobId/memory-view — response shape returns all ten trusted-memory sections**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape places confirmed memory into the correct section**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape shows corrected memory using accepted memory item fields, not original candidate text**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape includes budgetCategoryId on section items**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape returns normalized lowercase memoryType and job status**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape includes source context when sourceCandidateFactId exists**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape returns source: null for manual memory with no source fact**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape draft candidate facts do not appear in trusted sections**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape unresolved draft queue items appear in stillToCheck, not in trusted sections**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape GET memory-view performs no queue_items writes (read-only invariant)**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape stillToCheck count is 0 when no unresolved work exists**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — response shape includes generatedAt timestamp and normalized job summary**
  - Reason: The shared mock lacks the new Hours lookups. After fixing that, money-off removes budget_costs/budgetCategoryId and derives labels from accepted structured fields instead of stored model summaries.
  - Resolution: Pass with current-contract fixture/assertion.

### memory-view/memory-view.summary-sections.http.test.ts

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections includes cost fields and labels in section items**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections includes summarySections with correct keys and labels**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections summarySections item has costLabel, totalCostLabel, memoryItemIds, and uncertaintyFlags**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections summarySections costLabel and totalCostLabel are null when no cost stored**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections section items uncertaintyFlags come from unresolvedFlags**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections section items sourceUncertaintyFlags come from sourceFact**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — cost fields and summarySections section items have empty uncertaintyFlags and sourceUncertaintyFlags when no sourceFact**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation consolidates two compatible rows of same materialName + unit into one row**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation keeps rows separate when units differ (bags vs sheets)**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation keeps rows separate when any item has unresolved flags**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation keeps rows separate when any quantity is non-numeric**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation merged row nulls out cost labels (items may have different unit costs)**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation keeps rows separate when materialName is null even if unit matches**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation keeps rows separate when unit is null even if materialName matches**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/memory-view — summarySections consolidation verified items (empty unresolvedFlags) consolidate even when sourceFact had flags**
  - Reason: The shared mock lacks the new Hours lookups. Money-off summaries omit cost fields/labels rather than returning null. Non-money grouping and uncertainty assertions still run in both modes.
  - Resolution: Pass with current-contract fixture/assertion.

### review-queue/review-queue.decisions.http.test.ts

- **POST /api/jobs/:jobId/review-queue-decisions returns 409 when confirming a contradiction item**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions returns 409 when confirming an unclear_prompt item**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions confirm: creates memory from proposedMemory and marks source facts CONFIRMED**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions confirm: groups with multiple source facts update all of them**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions correct: creates memory with corrected fields and marks facts CORRECTED**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions confirm on duplicate group preserves both source fact IDs on the review decision**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions dismiss on duplicate group preserves both source fact IDs on the review decision**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions contradiction can be corrected into memory**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions dismiss: no memory created, marks facts REJECTED**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

- **POST /api/jobs/:jobId/review-queue-decisions dismiss without reason still succeeds**
  - Reason: Mocks supplied only a stored queue row with an arbitrary ID, without the unresolved source fact needed for fresh visibility checks. Seed the fact and use its deterministic derived ID; assert structured labels with money off.
  - Resolution: Pass with current-contract fixture/assertion.

### review-queue/review-queue.labour.http.test.ts

- **review-queue — labour suggests an active category named "labour" for labour facts**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour confirm persists labour fields and category into the memory item**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

- **review-queue — labour correct derives a safe per_hour total for labour**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour allows a category on labour via confirm**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment enriches a labour draft with an inherited person on exact name match and lists people**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment proposes no inherited person and hours-only when the name does not match**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment confirm persists the name-matched job-local person without a budget treatment**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment confirm honours an explicit labourBudgetEnabled override**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment correct persists a chosen labourPersonId without a budget treatment**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour people enrichment correct rejects a labourPersonId that is not an active person for the user**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Restoration-only assertion; passed in the full money-enabled run.

- **review-queue — labour happenedAt (Labour Tracking V2) confirm persists the proposed happenedAt on the memory item**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

- **review-queue — labour happenedAt (Labour Tracking V2) correct can edit day, person, hours, and task together**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

- **review-queue — labour happenedAt (Labour Tracking V2) correct with happenedAt omitted preserves the proposed effective day**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

- **review-queue — labour happenedAt (Labour Tracking V2) correct with happenedAt null clears the effective day**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

- **review-queue — labour happenedAt (Labour Tracking V2) confirming two labour queue items creates two memory items**
  - Reason: Mocks lack current source facts/derived IDs, or assert removed people/rate/category enrichment. Keep ordinary hours/date decisions in both modes and money-only enrichment assertions in restoration.
  - Resolution: Pass with current-contract fixture/assertion.

### review-queue/review-queue.read-write-split.http.test.ts

- **read endpoints are read-only with respect to queue_items GET /review-queue returns unresolved facts but writes no queue_items rows**
  - Reason: Legacy assertions expect model summaries and deletion of stale draft rows. Money-off uses structured labels and preserves those rows for reversibility; reads remain write-free.
  - Resolution: Pass with current-contract fixture/assertion.

- **decision write path materialises the derived queue POST decision succeeds for a GET-returned id when no queue_items row existed**
  - Reason: Legacy assertions expect model summaries and deletion of stale draft rows. Money-off uses structured labels and preserves those rows for reversibility; reads remain write-free.
  - Resolution: Pass with current-contract fixture/assertion.

- **decision write path materialises the derived queue stale draft rows are cleaned up by the decision write path, not by GET**
  - Reason: Legacy assertions expect model summaries and deletion of stale draft rows. Money-off uses structured labels and preserves those rows for reversibility; reads remain write-free.
  - Resolution: Pass with current-contract fixture/assertion.

### review-queue/review-queue.read.http.test.ts

- **GET /api/jobs/:jobId/review-queue returns empty queue when no unresolved facts**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue groups two same-name same-quantity facts as duplicate_group**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue groups same-name conflicting-quantity facts as contradiction**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue places UNCLEAR fact in unclear_items section as unclear_prompt**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue includes alreadyRemembered memory items**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue alreadyRemembered includes structured fields for frontend display**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

- **GET /api/jobs/:jobId/review-queue alreadyRemembered includes unitCostLabel and lineTotalLabel**
  - Reason: Legacy assertions expect nine sections, generic/model labels and money fields/flags. Money-off has six queue sections, structured memory labels and no money keys or cost-only uncertainty flags.
  - Resolution: Pass with current-contract fixture/assertion.

