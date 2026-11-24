import type { Prisma } from '@prisma/client'
import { isMoneyFeaturesEnabled } from '../config/features.js'
import { QUEUE_MEMORY_TYPES, memoryLabel, ignoreMoneyInput } from '../lib/job-memory.js'
import { createHash } from 'crypto'
import { prisma } from '../db/client.js'
import { ErrorCode } from '../types/errors.js'
import {
  formatUnitCostLabel,
  formatLineTotalLabel,
  deriveSafeMaterialTotal,
  deriveSafeLabourTotal,
  hasCostConflict,
} from '../lib/cost-utils.js'
import {
  getActiveBudgetCategories,
  suggestBudgetCategory,
  assertAssignableCategory,
} from './budget.js'
import {
  getActiveLabourPeople,
  matchLabourPersonByName,
  normalizeLabourPerson,
} from './labour-people.js'
import { MEMORY_TYPES, isCategoryAssignableApiMemoryType, apiMemoryTypeDefaultsToRecordedDay } from '../lib/memory-types.js'
import { ukLocalNoon, ukLocalDayString } from '../lib/dates.js'

type ActiveLabourPerson = Awaited<ReturnType<typeof getActiveLabourPeople>>[number]

// Resolve the job-local labour person + display name to persist when
// a labour draft is confirmed/corrected. An explicit chosen person id wins;
// otherwise the entry's person text is matched to an active person by exact name.
// Budget treatment: an explicit value wins, else the matched person's default,
// else hours-only. Person defaults never rewrite cost fields here (the reviewer
// sends corrected cost explicitly). Non-labour carries none of these.
function resolveLabourDecision(
  activePeople: ActiveLabourPerson[],
  opts: {
    isLabour: boolean
    personText: string | null | undefined
    personIdProvided: boolean
    personId: string | null | undefined
  },
): { labourPersonId: string | null; labourBudgetEnabled: boolean | null; labourPerson: string | null } {
  if (!isMoneyFeaturesEnabled()) return { labourPersonId: null, labourBudgetEnabled: null, labourPerson: opts.personText ?? null }
  if (!opts.isLabour) {
    return { labourPersonId: null, labourBudgetEnabled: null, labourPerson: opts.personText ?? null }
  }
  let person: ActiveLabourPerson | null = null
  if (opts.personIdProvided) {
    if (opts.personId != null) {
      person = activePeople.find((p) => p.id === opts.personId) ?? null
      if (!person) throw { code: ErrorCode.LABOUR_PERSON_NOT_FOUND, message: 'Labour person not found' }
    }
  } else {
    person = matchLabourPersonByName(activePeople, opts.personText)
  }
  const labourPerson =
    opts.personText && opts.personText.trim() !== '' ? opts.personText : person ? person.name : opts.personText ?? null
  return { labourPersonId: person?.id ?? null, labourBudgetEnabled: false, labourPerson }
}

// ── Section configuration ─────────────────────────────────────────────────────

// Queue sections come from the shared registry; GENERAL_NOTE facts have no
// review-queue section (general notes are direct-add memory, not queued facts).
const FACT_TYPE_TO_SECTION: Record<string, string> = Object.fromEntries(
  MEMORY_TYPES.filter((t) => t.storedType !== 'GENERAL_NOTE').map((t) => [t.storedType, t.sectionKey]),
)

const SECTION_LABELS: Record<string, string> = {
  ordered_materials: 'Ordered materials',
  used_materials: 'Used materials',
  leftovers: 'Leftovers',
  returned_materials: 'Returned materials',
  supplier_delivery_notes: 'Supplier delivery notes',
  customer_changes: 'Customer changes',
  watch_outs: 'Watch outs',
  labour: 'Labour',
  budget_costs: 'Costs',
  unclear_items: 'Unclear items',
}

const SECTION_KEYS = Object.keys(SECTION_LABELS).filter(key => key !== 'returned_materials')
const queueSectionKeys = (moneyEnabled: boolean) => moneyEnabled ? SECTION_KEYS : [...SECTION_KEYS, 'returned_materials']

// Stable deterministic ID derived from the job + sorted source fact IDs.
// Same inputs always produce the same ID so GET regenerations never invalidate
// in-flight decision requests from a prior GET.
function computeGroupId(jobId: string, factIds: string[]): string {
  const h = createHash('sha256')
    .update(`${jobId}:${[...factIds].sort().join('|')}`)
    .digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposedMemory {
  memoryType: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  deliveryTiming: string | null
  locationOrUse: string | null
  costAmount: string | null
  costCurrency: string | null
  costQualifier: string | null
  totalCostAmount: string | null
  labourHours: string | null
  labourPerson: string | null
  labourTask: string | null
  happenedAt: string | null
  // Labour people enrichment (added at read time; base draft carries null).
  labourPersonId: string | null
  labourBudgetEnabled: boolean | null
}

interface GroupedItemData {
  sectionKey: string
  kind: 'SINGLE' | 'DUPLICATE_GROUP' | 'CONTRADICTION' | 'UNCLEAR_PROMPT'
  reviewLabel: string
  summary: string
  proposedMemory: ProposedMemory
  confidenceLabel: string
  uncertaintyFlags: string[]
  sourceCandidateFactIds: string[]
}

type FactWithContext = {
  id: string
  factType: string
  status: string
  summary: string
  materialName: string | null
  quantity: string | null
  unit: string | null
  supplierName: string | null
  deliveryTiming: string | null
  locationOrUse: string | null
  costAmount: string | null
  costCurrency: string | null
  costQualifier: string | null
  totalCostAmount: string | null
  labourHours: string | null
  labourPerson: string | null
  labourTask: string | null
  happenedAt: Date | null
  confidenceLabel: string
  uncertaintyFlags: string[]
  sourceNoteId: string
  sourceTranscriptId: string
  sourceNote: { id: string; capturedAt: Date }
  transcript: { id: string; text: string | null }
}

export interface CorrectedFields {
  memoryType: string
  summary: string
  materialName?: string | null
  quantity?: string | null
  unit?: string | null
  supplierName?: string | null
  deliveryTiming?: string | null
  locationOrUse?: string | null
  costAmount?: string | null
  costCurrency?: string | null
  costQualifier?: string | null
  totalCostAmount?: string | null
  labourHours?: string | null
  labourPerson?: string | null
  labourTask?: string | null
  labourPersonId?: string | null
  labourBudgetEnabled?: boolean | null
  happenedAt?: string | null
  budgetCategoryId?: string | null
}

export type QueueDecisionPayload =
  | { action: 'confirm'; queueItemId: string; uncertaintyResolution?: 'resolved' | 'still_unsure'; budgetCategoryId?: string | null; labourPersonId?: string | null; labourBudgetEnabled?: boolean | null }
  | { action: 'correct'; queueItemId: string; corrected: CorrectedFields; uncertaintyResolution?: 'resolved' | 'still_unsure'; budgetCategoryId?: string | null }
  | { action: 'dismiss'; queueItemId: string; reason?: string }

// Reconcile a top-level and a corrected category id, validate against the job,
// and enforce that a category is only attached to ordered_material memory.
// Returns the category id to persist (or null for "remembered with no category").
async function resolveDecisionCategory(
  jobId: string,
  finalMemoryType: string,
  topLevel: string | null | undefined,
  inner: string | null | undefined,
): Promise<string | null> {
  if (!isMoneyFeaturesEnabled()) return null
  let provided: string | null | undefined
  if (topLevel !== undefined && inner !== undefined) {
    if (topLevel !== inner) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId and corrected.budgetCategoryId must match' }
    }
    provided = topLevel
  } else {
    provided = topLevel !== undefined ? topLevel : inner
  }

  if (provided === undefined || provided === null) return null

  if (!isCategoryAssignableApiMemoryType(finalMemoryType)) {
    throw { code: ErrorCode.INVALID_FIELD, message: 'budgetCategoryId is only allowed on ordered_material, labour, or budget_cost memory' }
  }
  await assertAssignableCategory(jobId, provided)
  return provided
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

function extractProposedMemory(f: FactWithContext): ProposedMemory {
  return {
    memoryType: f.factType.toLowerCase(),
    summary: f.summary,
    materialName: f.materialName,
    quantity: f.quantity,
    unit: f.unit,
    supplierName: f.supplierName,
    deliveryTiming: f.deliveryTiming,
    locationOrUse: f.locationOrUse,
    costAmount: f.costAmount,
    costCurrency: f.costCurrency,
    costQualifier: f.costQualifier,
    totalCostAmount: f.totalCostAmount,
    labourHours: f.labourHours,
    labourPerson: f.labourPerson,
    labourTask: f.labourTask,
    happenedAt: f.happenedAt ? f.happenedAt.toISOString() : null,
    // Extraction does not know labour people; enriched at read time.
    labourPersonId: null,
    labourBudgetEnabled: null,
  }
}

function mostCompleteFact(facts: FactWithContext[]): FactWithContext {
  const score = (f: FactWithContext) =>
    [f.materialName, f.quantity, f.unit, f.supplierName, f.deliveryTiming, f.locationOrUse].filter(
      (v) => v != null,
    ).length
  return facts.reduce((best, f) => (score(f) >= score(best) ? f : best))
}

function unionFlags(facts: FactWithContext[]): string[] {
  return [...new Set(facts.flatMap((f) => f.uncertaintyFlags))]
}

function deriveConfidence(facts: FactWithContext[]): string {
  const labels = facts.map((f) => f.confidenceLabel)
  if (labels.includes('LOW')) return 'low'
  if (labels.every((l) => l === 'HIGH')) return 'high'
  return 'medium'
}

function groupTypedFactsForSection(facts: FactWithContext[], sectionKey: string): GroupedItemData[] {
  const items: GroupedItemData[] = []

  const byName = new Map<string, FactWithContext[]>()
  const unnamed: FactWithContext[] = []

  for (const f of facts) {
    const name = f.materialName?.toLowerCase().trim()
    if (!name) {
      unnamed.push(f)
    } else {
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name)!.push(f)
    }
  }

  for (const [, group] of byName) {
    if (group.length === 1) {
      const f = group[0]
      items.push({
        sectionKey,
        kind: 'SINGLE',
        reviewLabel: '',
        summary: f.summary,
        proposedMemory: extractProposedMemory(f),
        confidenceLabel: f.confidenceLabel.toLowerCase(),
        uncertaintyFlags: f.uncertaintyFlags,
        sourceCandidateFactIds: [f.id],
      })
    } else {
      const quantities = group.map((f) => f.quantity?.trim()).filter((q): q is string => !!q)
      const uniqueQuantities = new Set(quantities)
      const isContradiction = quantities.length >= 2 && uniqueQuantities.size > 1

      if (isContradiction) {
        const representative = mostCompleteFact(group)
        items.push({
          sectionKey,
          kind: 'CONTRADICTION',
          reviewLabel: 'Worth checking',
          summary: `Conflicting information about ${group[0].materialName}`,
          proposedMemory: extractProposedMemory(representative),
          confidenceLabel: 'low',
          uncertaintyFlags: [...new Set([...unionFlags(group), 'conflicting_quantity'])],
          sourceCandidateFactIds: group.map((f) => f.id),
        })
      } else {
        const primary = mostCompleteFact(group)
        items.push({
          sectionKey,
          kind: 'DUPLICATE_GROUP',
          reviewLabel: 'Looks like the same item',
          summary: primary.summary,
          proposedMemory: extractProposedMemory(primary),
          confidenceLabel: deriveConfidence(group),
          uncertaintyFlags: unionFlags(group),
          sourceCandidateFactIds: group.map((f) => f.id),
        })
      }
    }
  }

  for (const f of unnamed) {
    items.push({
      sectionKey,
      kind: 'SINGLE',
      reviewLabel: '',
      summary: f.summary,
      proposedMemory: extractProposedMemory(f),
      confidenceLabel: f.confidenceLabel.toLowerCase(),
      uncertaintyFlags: f.uncertaintyFlags,
      sourceCandidateFactIds: [f.id],
    })
  }

  return items
}

function groupAllFacts(facts: FactWithContext[], moneyEnabled = true): GroupedItemData[] {
  const unclearFacts = facts.filter((f) => f.factType === 'UNCLEAR' || f.status === 'UNCLEAR')
  const typedFacts = facts.filter((f) => f.factType !== 'UNCLEAR' && f.status !== 'UNCLEAR')

  const bySectionKey = new Map<string, FactWithContext[]>()
  for (const key of queueSectionKeys(moneyEnabled).filter((k) => k !== 'unclear_items')) bySectionKey.set(key, [])
  for (const f of typedFacts) {
    const key = FACT_TYPE_TO_SECTION[f.factType]
    if (key && bySectionKey.has(key)) bySectionKey.get(key)!.push(f)
  }

  const items: GroupedItemData[] = []
  for (const [sectionKey, sectionFacts] of bySectionKey) {
    items.push(...groupTypedFactsForSection(sectionFacts, sectionKey))
  }

  for (const f of unclearFacts) {
    items.push({
      sectionKey: 'unclear_items',
      kind: 'UNCLEAR_PROMPT',
      reviewLabel: 'Needs clarification',
      summary: f.summary,
      proposedMemory: extractProposedMemory(f),
      confidenceLabel: 'low',
      uncertaintyFlags: f.uncertaintyFlags,
      sourceCandidateFactIds: [f.id],
    })
  }

  return items
}

// ── Time label ────────────────────────────────────────────────────────────────

function computeTimeLabel(timestamp: Date, now: Date): string {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1)
  if (timestamp >= todayStart) return 'Today'
  if (timestamp >= yesterdayStart) return 'Yesterday'
  return 'Earlier'
}

function groupTimeLabel(sourceCandidateFactIds: string[], factMap: Map<string, FactWithContext>, now: Date): string {
  const times = sourceCandidateFactIds
    .map((id) => factMap.get(id)?.sourceNote.capturedAt)
    .filter((d): d is Date => d != null)
  if (times.length === 0) return 'Earlier'
  const mostRecent = new Date(Math.max(...times.map((d) => d.getTime())))
  return computeTimeLabel(mostRecent, now)
}

// ── Access control ────────────────────────────────────────────────────────────

async function verifyJobOwnership(jobId: string, userId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } })
  if (!job) throw { code: ErrorCode.JOB_NOT_FOUND, message: 'Job not found' }
  if (job.ownerUserId !== userId) throw { code: ErrorCode.FORBIDDEN, message: 'Access denied' }
  return job
}

// ── Queue derivation (read-only) and materialisation (write path) ─────────────
//
// Derivation reads unresolved candidate facts and computes the queue —
// deterministic ids included — without ever touching queue_items. Every read
// path (review-queue GET, memory-view, inspection) uses it, so reads are
// read-only. Materialisation persists the derived rows and is called only from
// the decision write path, where the audit trail needs a queue_items row.

// Exported for tests that need to predict derived queue item ids.
export const computeQueueItemId = computeGroupId

export async function deriveFreshQueueSections(jobId: string, now: Date, moneyEnabled = true, db: Pick<Prisma.TransactionClient, 'candidateFact'> = prisma) {
  const facts = await db.candidateFact.findMany({
    where: { jobId, status: { in: ['DRAFT', 'UNCLEAR'] } },
    include: {
      sourceNote: { select: { id: true, capturedAt: true } },
      transcript: { select: { id: true, text: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const factMap = new Map(facts.map((f) => [f.id, f]))
  const visibleFacts = moneyEnabled ? facts : facts.filter(f => QUEUE_MEMORY_TYPES.has(f.factType) && (f.factType !== 'LABOUR' || f.labourHours != null)).map(f => ({ ...f, summary: memoryLabel(f), uncertaintyFlags: f.uncertaintyFlags.filter(flag => !/cost|budget|paid|refund/i.test(flag)), costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null }))
  const grouped = groupAllFacts(visibleFacts, moneyEnabled)
  if (!moneyEnabled) for (const item of grouped) {
    item.summary = memoryLabel(item.proposedMemory)
    item.reviewLabel = item.summary
    item.proposedMemory.summary = item.summary
  }

  // Assign deterministic IDs so the same grouping always yields the same UUID
  // and an id returned by a GET stays valid for a later decision POST.
  const items = grouped.map((item) => ({
    id: computeGroupId(jobId, item.sourceCandidateFactIds),
    jobId,
    sectionKey: item.sectionKey,
    kind: item.kind,
    status: 'draft',
    reviewLabel: item.reviewLabel,
    timeLabel: groupTimeLabel(item.sourceCandidateFactIds, factMap, now),
    summary: item.summary,
    proposedMemory: item.proposedMemory as object,
    confidenceLabel: item.confidenceLabel,
    uncertaintyFlags: item.uncertaintyFlags,
    sourceCandidateFactIds: item.sourceCandidateFactIds,
  }))

  const sections = queueSectionKeys(moneyEnabled).filter(key => moneyEnabled || !['budget_costs', 'supplier_delivery_notes', 'customer_changes', 'watch_outs'].includes(key)).map((key) => ({
    key,
    label: !moneyEnabled && key === 'labour' ? 'Hours' : SECTION_LABELS[key],
    items: items
      .filter((item) => item.sectionKey === key)
      .map((item) => ({
        id: item.id,
        kind: item.kind.toLowerCase(),
        status: item.status,
        reviewLabel: item.reviewLabel,
        timeLabel: item.timeLabel,
        summary: item.summary,
        proposedMemory: item.proposedMemory,
        confidenceLabel: item.confidenceLabel,
        uncertaintyFlags: item.uncertaintyFlags,
        sourceCandidateFactIds: item.sourceCandidateFactIds,
      })),
  }))

  return { sections, factMap, items }
}

// Persist the derived queue for a job: create missing rows (stable ids make
// this idempotent) and delete stale DRAFT rows whose source facts are no longer
// unresolved. Never touches decided rows — they are the audit trail. Called
// from the decision write path only, so read endpoints stay read-only.
export async function syncReviewQueueForJob(jobId: string, now: Date, moneyEnabled = true) {
  const { items } = await deriveFreshQueueSections(jobId, now, moneyEnabled)
  const currentIds = items.map((i) => i.id)

  if (moneyEnabled) await prisma.queueItem.deleteMany({
    where: currentIds.length > 0
      ? { jobId, status: 'draft', id: { notIn: currentIds } }
      : { jobId, status: 'draft' },
  })

  if (items.length > 0) {
    await prisma.queueItem.createMany({ data: items, skipDuplicates: true })
  }
  return items
}

// ── GET /api/jobs/:jobId/review-queue ─────────────────────────────────────────

export async function getReviewQueue(jobId: string, userId: string, moneyEnabled = true) {
  await verifyJobOwnership(jobId, userId)

  const now = new Date()

  const { sections: baseSections, factMap } = await deriveFreshQueueSections(jobId, now, moneyEnabled)

  // Active categories drive review-time suggestions, recomputed on every GET so a
  // queue item created before categories changed still reflects current categories.
  // Active labour people drive labour draft enrichment the same way.
  const [budgetCategories, activeLabourPeople] = await Promise.all([
    getActiveBudgetCategories(jobId),
    getActiveLabourPeople(jobId),
  ])

  // Add sourceContext and a (response-only) budget category suggestion to each item.
  const sections = baseSections.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      const pm = item.proposedMemory as unknown as ProposedMemory
      const suggestion = suggestBudgetCategory(
        { memoryType: pm.memoryType, materialName: pm.materialName, summary: pm.summary, labourTask: pm.labourTask },
        budgetCategories,
      )
      // Labour enrichment: an exact-name match to an active person proposes that
      // person's default rate/treatment. Ambiguous/no match → no inherited person
      // and hours-only by default. All of this is visible and user-correctable.
      const inheritedPerson =
        pm.memoryType === 'labour' ? matchLabourPersonByName(activeLabourPeople, pm.labourPerson) : null
      const labourEnrichment =
        pm.memoryType === 'labour'
          ? {
              labourPersonId: inheritedPerson ? inheritedPerson.id : null,
              inheritedLabourPerson: inheritedPerson ? normalizeLabourPerson(inheritedPerson) : null,
              inheritedBudgetTreatment: null,
            }
          : { labourPersonId: null, inheritedLabourPerson: null, inheritedBudgetTreatment: null }
      return {
        ...item,
        proposedMemory: {
          ...pm,
          budgetCategoryId: suggestion ? suggestion.budgetCategoryId : null,
          budgetCategorySuggestion: suggestion,
          ...labourEnrichment,
        },
        sourceContext: item.sourceCandidateFactIds.flatMap((id) => {
          const f = factMap.get(id)
          if (!f) return []
          return [{
            candidateFactId: f.id,
            noteId: f.sourceNoteId,
            transcriptId: f.sourceTranscriptId,
            capturedAt: f.sourceNote.capturedAt,
            transcriptText: f.transcript.text ?? null,
          }]
        }),
      }
    }),
  }))

  const memoryItems = await prisma.memoryItem.findMany({
    where: { jobId, isRemoved: false },
    include: { sourceFact: { select: { uncertaintyFlags: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const alreadyRemembered = memoryItems.filter(m => moneyEnabled || (m.memoryType !== 'BUDGET_COST' && (m.memoryType !== 'LABOUR' || m.labourHours != null))).map((m) => ({
    memoryItemId: m.id,
    summary: m.summary,
    memoryType: m.memoryType.toLowerCase(),
    timeLabel: computeTimeLabel(m.createdAt, now),
    materialName: m.materialName,
    quantity: m.quantity,
    unit: m.unit,
    supplierName: m.supplierName,
    deliveryTiming: m.deliveryTiming,
    locationOrUse: m.locationOrUse,
    costAmount: m.costAmount,
    costCurrency: m.costCurrency,
    costQualifier: m.costQualifier,
    totalCostAmount: m.totalCostAmount,
    labourHours: m.labourHours,
    labourPerson: m.labourPerson,
    labourTask: m.labourTask,
    labourPersonId: m.labourPersonId,
    labourBudgetEnabled: m.labourBudgetEnabled,
    happenedAt: m.happenedAt,
    unitCostLabel: formatUnitCostLabel(m.costAmount, m.costCurrency, m.costQualifier),
    lineTotalLabel: formatLineTotalLabel(m.totalCostAmount, m.costCurrency),
    uncertaintyFlags: m.unresolvedFlags,
    sourceUncertaintyFlags: m.sourceFact?.uncertaintyFlags ?? [],
    budgetCategoryId: m.budgetCategoryId,
  }))

  const labourPeople = activeLabourPeople.map(normalizeLabourPerson)

  return { jobId, generatedAt: now, budgetCategories, labourPeople, sections, alreadyRemembered }
}

// ── POST /api/jobs/:jobId/review-queue-decisions ──────────────────────────────


// The day the note behind a queue item was captured, as UK local noon. Used as
// the recorded day for a confirmed/corrected memory whose type reads its date
// back as evidence and whose draft carries none — typically a candidate fact
// extracted before that default existed. It is the note's own capture day, not
// the review day: confirming a week later must not date the purchase today.
async function sourceNoteCaptureDay(sourceCandidateFactIds: string[]): Promise<Date | null> {
  const factId = sourceCandidateFactIds[0]
  if (!factId) return null
  const fact = await prisma.candidateFact.findUnique({
    where: { id: factId },
    select: { sourceNote: { select: { capturedAt: true } } },
  })
  const capturedAt = fact?.sourceNote?.capturedAt
  return capturedAt ? ukLocalNoon(ukLocalDayString(capturedAt)) : null
}

// A move or another decision can win after the queue was derived. Check
// the source rows in the write transaction before recording trusted memory.
async function decideQueueFacts(
  tx: Prisma.TransactionClient, jobId: string, ids: string[],
  status: 'CONFIRMED' | 'CORRECTED' | 'REJECTED',
) {
  const result = await tx.candidateFact.updateMany({
    where: { id: { in: ids }, jobId, status: { in: ['DRAFT', 'UNCLEAR'] } },
    data: { status },
  })
  if (result.count !== ids.length) {
    throw { code: ErrorCode.QUEUE_ITEM_ALREADY_DECIDED, message: 'This check changed. Refresh the review queue.' }
  }
}

export async function submitQueueDecision(jobId: string, userId: string, payload: QueueDecisionPayload) {
  await verifyJobOwnership(jobId, userId)

  // Reads no longer persist queue items, so materialise the derived queue now:
  // a deterministic id returned by a prior GET must exist as a queue_items row
  // before the decision can be recorded against it.
  const moneyEnabled = isMoneyFeaturesEnabled()
  const derivedItems = await syncReviewQueueForJob(jobId, new Date(), moneyEnabled)

  const item = await prisma.queueItem.findFirst({
    where: { id: payload.queueItemId, jobId },
  })

  if (!item) throw { code: ErrorCode.QUEUE_ITEM_NOT_FOUND, message: 'Queue item not found' }

  if (item.status !== 'draft') {
    throw {
      code: ErrorCode.QUEUE_ITEM_ALREADY_DECIDED,
      message: `Item has already been decided (status: ${item.status})`,
    }
  }

  const visibleItem = derivedItems.find(i => i.id === item.id)
  if (!moneyEnabled && !visibleItem) throw { code: ErrorCode.QUEUE_ITEM_NOT_FOUND, message: 'Queue item not found' }

  if (payload.action === 'confirm' && (item.kind === 'CONTRADICTION' || item.kind === 'UNCLEAR_PROMPT')) {
    throw {
      code: ErrorCode.QUEUE_ITEM_CONFIRM_NOT_ALLOWED,
      message: 'Contradictions and unclear items must be corrected or dismissed',
    }
  }

  const storedPm = (moneyEnabled ? item.proposedMemory : visibleItem!.proposedMemory) as unknown as ProposedMemory
  const pm = moneyEnabled ? storedPm : { ...ignoreMoneyInput(storedPm), summary: memoryLabel(storedPm), costAmount: null, costCurrency: null, costQualifier: null, totalCostAmount: null }
  const effectiveFlags = moneyEnabled ? item.uncertaintyFlags : visibleItem!.uncertaintyFlags
  const sourceCandidateFactIds = item.sourceCandidateFactIds

  if (payload.action === 'confirm') {
    const unresolvedFlags =
      payload.uncertaintyResolution === 'still_unsure' ? effectiveFlags : []

    const budgetCategoryId = await resolveDecisionCategory(
      jobId, pm.memoryType, payload.budgetCategoryId, undefined,
    )

    // The day this memory is for. The draft's day wins; when it has none and the
    // type reads its date back as evidence, the note's capture day is recorded.
    const confirmHappenedAt =
      (pm.happenedAt ? new Date(pm.happenedAt) : null) ??
      (apiMemoryTypeDefaultsToRecordedDay(pm.memoryType)
        ? await sourceNoteCaptureDay(sourceCandidateFactIds)
        : null)

    // Labour person/Budget treatment: an explicit payload choice wins, else the
    // draft's person text is matched to an active person's defaults.
    const activeLabourPeople = await getActiveLabourPeople(jobId)
    const confirmLabour = resolveLabourDecision(activeLabourPeople, {
      isLabour: pm.memoryType === 'labour',
      personText: pm.labourPerson,
      personIdProvided: payload.labourPersonId !== undefined,
      personId: payload.labourPersonId,
    })

    const result = await prisma.$transaction(async (tx) => {
      await tx.queueItem.update({ where: { id: item.id, jobId, status: 'draft' }, data: { status: 'confirmed' } })
      await decideQueueFacts(tx, jobId, sourceCandidateFactIds, 'CONFIRMED')

      const decision = await tx.reviewDecision.create({
        data: {
          jobId,
          decidedBy: userId,
          action: 'QUEUE_CONFIRM',
          candidateFactId: sourceCandidateFactIds[0] ?? null,
          sourceCandidateFactIds,
        },
      })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          reviewDecisionId: decision.id,
          sourceCandidateFactId: sourceCandidateFactIds[0] ?? null,
          memoryType: (pm.memoryType.toUpperCase()) as never,
          isManual: false,
          summary: pm.summary,
          materialName: pm.materialName,
          quantity: pm.quantity,
          unit: pm.unit,
          supplierName: pm.supplierName,
          deliveryTiming: pm.deliveryTiming,
          locationOrUse: pm.locationOrUse,
          ...(moneyEnabled ? {
            costAmount: pm.costAmount,
            costCurrency: pm.costCurrency,
            costQualifier: pm.costQualifier,
            totalCostAmount: pm.totalCostAmount,
          } : {}),
          labourHours: pm.labourHours,
          labourPerson: confirmLabour.labourPerson,
          labourTask: pm.labourTask,
          ...(moneyEnabled ? { labourPersonId: confirmLabour.labourPersonId, labourBudgetEnabled: confirmLabour.labourBudgetEnabled } : {}),
          happenedAt: confirmHappenedAt,
          unresolvedFlags,
          ...(moneyEnabled ? { budgetCategoryId } : {}),
        },
      })


      return memoryItem
    })

    return {
      queueItemId: item.id,
      action: 'confirm',
      status: 'confirmed',
      memoryItemId: result.id,
      sourceCandidateFactIds,
    }
  }

  if (payload.action === 'correct') {
    const corrected = moneyEnabled ? payload.corrected : { ...ignoreMoneyInput(payload.corrected), summary: memoryLabel(payload.corrected), costAmount: undefined, costCurrency: undefined, costQualifier: undefined, totalCostAmount: undefined }
    if (!moneyEnabled && (!QUEUE_MEMORY_TYPES.has(corrected.memoryType.toUpperCase()) || corrected.memoryType === 'unclear')) throw { code: ErrorCode.INVALID_FIELD, message: 'Choose a material or hours memory type' }
    const memoryType = (corrected.memoryType.toUpperCase()) as never

    const budgetCategoryId = await resolveDecisionCategory(
      jobId, corrected.memoryType.toLowerCase(), payload.budgetCategoryId, corrected.budgetCategoryId,
    )

    // Preserve an explicit total, else safely derive from material each or labour per_hour.
    const correctedTotalCostAmount =
      corrected.totalCostAmount ??
      deriveSafeMaterialTotal(corrected.quantity, corrected.unit, corrected.costAmount, corrected.costCurrency, corrected.costQualifier) ??
      deriveSafeLabourTotal(corrected.labourHours, corrected.costAmount, corrected.costQualifier) ??
      null

    // An explicit total that conflicts with quantity × unit cost must stay worth
    // checking, even if the reviewer marked the item resolved.
    // The effective day: an explicit corrected value (null clears) wins; when the
    // correction doesn't mention it, the proposed draft's day is preserved so a
    // person/hours edit never silently wipes the labour day.
    //
    // An explicit null is a deliberate "I don't know when" and is honoured as
    // null — only a correction that never mentions the date falls back, first to
    // the draft's day and then, for types whose date is evidence, to the note's
    // capture day.
    const correctedHappenedAt =
      corrected.happenedAt !== undefined
        ? (corrected.happenedAt ? new Date(corrected.happenedAt) : null)
        : ((pm.happenedAt ? new Date(pm.happenedAt) : null) ??
           (apiMemoryTypeDefaultsToRecordedDay(corrected.memoryType.toLowerCase())
             ? await sourceNoteCaptureDay(sourceCandidateFactIds)
             : null))
    if (correctedHappenedAt !== null && Number.isNaN(correctedHappenedAt.getTime())) {
      throw { code: ErrorCode.INVALID_FIELD, message: 'corrected.happenedAt must be a valid ISO date/time' }
    }

    const conflict = hasCostConflict(corrected.quantity, corrected.costAmount, corrected.costQualifier, correctedTotalCostAmount)
    const baseFlags = payload.uncertaintyResolution === 'still_unsure' ? effectiveFlags : []
    const unresolvedFlags =
      conflict && !baseFlags.includes('cost_uncertain') ? [...baseFlags, 'cost_uncertain'] : baseFlags

    // Labour person/Budget treatment from the corrected fields: explicit choice
    // wins, else match the corrected person text to an active person's defaults.
    const activeLabourPeople = await getActiveLabourPeople(jobId)
    const correctLabour = resolveLabourDecision(activeLabourPeople, {
      isLabour: corrected.memoryType.toLowerCase() === 'labour',
      personText: corrected.labourPerson,
      personIdProvided: corrected.labourPersonId !== undefined,
      personId: corrected.labourPersonId,
    })

    const result = await prisma.$transaction(async (tx) => {
      await tx.queueItem.update({ where: { id: item.id, jobId, status: 'draft' }, data: { status: 'corrected' } })
      await decideQueueFacts(tx, jobId, sourceCandidateFactIds, 'CORRECTED')

      const decision = await tx.reviewDecision.create({
        data: {
          jobId,
          decidedBy: userId,
          action: 'QUEUE_CORRECT',
          candidateFactId: sourceCandidateFactIds[0] ?? null,
          sourceCandidateFactIds,
        },
      })

      const memoryItem = await tx.memoryItem.create({
        data: {
          jobId,
          reviewDecisionId: decision.id,
          sourceCandidateFactId: sourceCandidateFactIds[0] ?? null,
          memoryType,
          isManual: false,
          summary: corrected.summary,
          materialName: corrected.materialName ?? null,
          quantity: corrected.quantity ?? null,
          unit: corrected.unit ?? null,
          supplierName: corrected.supplierName ?? null,
          deliveryTiming: corrected.deliveryTiming ?? null,
          locationOrUse: corrected.locationOrUse ?? null,
          ...(moneyEnabled ? {
            costAmount: corrected.costAmount ?? null,
            costCurrency: corrected.costCurrency ?? null,
            costQualifier: corrected.costQualifier ?? null,
            totalCostAmount: correctedTotalCostAmount,
          } : {}),
          labourHours: corrected.labourHours ?? null,
          labourPerson: correctLabour.labourPerson,
          labourTask: corrected.labourTask ?? null,
          ...(moneyEnabled ? { labourPersonId: correctLabour.labourPersonId, labourBudgetEnabled: correctLabour.labourBudgetEnabled } : {}),
          happenedAt: correctedHappenedAt,
          unresolvedFlags,
          ...(moneyEnabled ? { budgetCategoryId } : {}),
        },
      })


      return memoryItem
    })

    return {
      queueItemId: item.id,
      action: 'correct',
      status: 'corrected',
      memoryItemId: result.id,
      sourceCandidateFactIds,
    }
  }

  // dismiss
  await prisma.$transaction(async (tx) => {
    await tx.queueItem.update({ where: { id: item.id, jobId, status: 'draft' }, data: { status: 'dismissed' } })
    await decideQueueFacts(tx, jobId, sourceCandidateFactIds, 'REJECTED')

    await tx.reviewDecision.create({
      data: {
        jobId,
        decidedBy: userId,
        action: 'QUEUE_DISMISS',
        candidateFactId: sourceCandidateFactIds[0] ?? null,
        reason: payload.reason ?? null,
        sourceCandidateFactIds,
      },
    })

  })

  return {
    queueItemId: item.id,
    action: 'dismiss',
    status: 'dismissed',
    memoryItemId: null,
    sourceCandidateFactIds,
  }
}
