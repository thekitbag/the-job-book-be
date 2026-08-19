// The shared vocabulary of the Workshop: how availability states are named on
// the wire, how a source leftover's Workshop state is derived, and how entered/
// resolved dates are written for a screen Mike scans.
//
// Workshop is availability memory, never inventory and never finance. Nothing
// in here parses, normalises, totals or sharpens a rough amount — free text in,
// the same free text out.
//
// Pure module: no Prisma, no route/service imports.
import { ukLocalDayString, ukShortDateLabel } from './dates.js'

export const WORKSHOP_STATES = ['AVAILABLE', 'USED_UP', 'WASNT_THERE', 'MOVED_BACK'] as const
export type StoredWorkshopState = (typeof WORKSHOP_STATES)[number]

export type WireWorkshopState = 'available' | 'used_up' | 'wasnt_there' | 'moved_back'

// The Workshop state the SOURCE leftover shows in job read models. Derived from
// the linked Workshop row — never stored on the memory item, so a Workshop
// action can only ever write one row and the two views cannot disagree.
export type SourceWorkshopState = 'not_moved' | 'in_workshop' | 'used_up' | 'wasnt_there'

const SOURCE_STATE_BY_STORED: Record<StoredWorkshopState, SourceWorkshopState> = {
  AVAILABLE: 'in_workshop',
  USED_UP: 'used_up',
  WASNT_THERE: 'wasnt_there',
  // An undone move leaves the row behind (it carries the latest wording) but
  // the source is back to never-moved as far as Mike is concerned.
  MOVED_BACK: 'not_moved',
}

export function toWireState(state: StoredWorkshopState): WireWorkshopState {
  return state.toLowerCase() as WireWorkshopState
}

export function sourceStateFor(state: StoredWorkshopState | null | undefined): SourceWorkshopState {
  return state ? SOURCE_STATE_BY_STORED[state] : 'not_moved'
}

// States a source leftover can be moved (or moved back) into the Workshop from.
// AVAILABLE is the one that blocks a move: the material is already in there.
export const MOVABLE_SOURCE_STATES: ReadonlySet<StoredWorkshopState> = new Set([
  'USED_UP', 'WASNT_THERE', 'MOVED_BACK',
])

export const TERMINAL_STATES: ReadonlySet<StoredWorkshopState> = new Set(['USED_UP', 'WASNT_THERE'])

export const MANUAL_SOURCE_LABEL = 'Added by hand'

// Job status as Workshop rows show it. `archived` is a real stored status a job
// can be patched into; a Workshop item outlives its source job's archiving, so
// it is labelled honestly rather than being hidden or relabelled as finished.
export const WORKSHOP_JOB_STATUS_LABELS: Record<string, string> = {
  planning: 'Planning',
  started: 'In progress',
  finished: 'Finished',
  archived: 'Archived',
}

// Rough amount is free text: trim for storage, and treat blank as "not known"
// rather than as a quantity of zero.
export function normalizeRoughAmount(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// The rough amount a move starts from when Mike does not type one: the source
// leftover's own display wording, copied across as-is. Never recomputed.
export function roughAmountFromSource(quantity: string | null, unit: string | null): string | null {
  const q = quantity?.trim()
  if (!q) return null
  const u = unit?.trim()
  return u ? `${q} ${u}` : q
}

// "6 things" / "1 thing". Null when the Workshop is empty — an empty Workshop
// row shows no count at all rather than a "0 things" that reads as a finding.
export function availableCountLabel(count: number): string | null {
  if (count <= 0) return null
  return `${count} ${count === 1 ? 'thing' : 'things'}`
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Entered/resolved dates read as recency for the first week ("Today",
// "3 days ago") and as a plain UK date after that. Calendar days in Europe/
// London, so "Yesterday" flips at local midnight rather than 24 hours later.
export function workshopDateLabel(instant: Date, now: Date = new Date()): string {
  const day = ukLocalDayString(instant)
  const today = ukLocalDayString(now)
  if (day === today) return 'Today'
  const diffDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / MS_PER_DAY)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays > 1 && diffDays <= 6) return `${diffDays} days ago`
  return ukShortDateLabel(instant)
}
