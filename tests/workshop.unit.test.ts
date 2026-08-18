// The Workshop's pure vocabulary: how availability states map to what a source
// leftover shows, and how entered/resolved dates and counts are written. Kept
// as unit tests because the recency branches ("3 days ago" vs a plain date) are
// awkward to drive from an HTTP test that can only ever say "Today".
import { describe, expect, it } from 'vitest'
import {
  availableCountLabel,
  normalizeRoughAmount,
  roughAmountFromSource,
  sourceStateFor,
  workshopDateLabel,
} from '../src/lib/workshop.js'

describe('sourceStateFor', () => {
  it('maps each stored state to what the source leftover shows', () => {
    expect(sourceStateFor(null)).toBe('not_moved')
    expect(sourceStateFor(undefined)).toBe('not_moved')
    expect(sourceStateFor('AVAILABLE')).toBe('in_workshop')
    expect(sourceStateFor('USED_UP')).toBe('used_up')
    expect(sourceStateFor('WASNT_THERE')).toBe('wasnt_there')
    // An undone move is not a Workshop state Mike ever sees on the source row.
    expect(sourceStateFor('MOVED_BACK')).toBe('not_moved')
  })
})

describe('availableCountLabel', () => {
  it('counts things, and says nothing at all when there are none', () => {
    expect(availableCountLabel(0)).toBeNull()
    expect(availableCountLabel(1)).toBe('1 thing')
    expect(availableCountLabel(6)).toBe('6 things')
  })
})

describe('workshopDateLabel', () => {
  // Europe/London calendar days, so the labels flip at local midnight.
  const now = new Date('2026-08-18T09:00:00.000Z')

  it('reads as recency for the first week and as a date after it', () => {
    expect(workshopDateLabel(new Date('2026-08-18T04:00:00.000Z'), now)).toBe('Today')
    expect(workshopDateLabel(new Date('2026-08-17T22:00:00.000Z'), now)).toBe('Yesterday')
    expect(workshopDateLabel(new Date('2026-08-15T12:00:00.000Z'), now)).toBe('3 days ago')
    expect(workshopDateLabel(new Date('2026-08-12T12:00:00.000Z'), now)).toBe('6 days ago')
    expect(workshopDateLabel(new Date('2026-08-11T12:00:00.000Z'), now)).toBe('11 Aug 2026')
  })

  it('uses the London day, not the UTC day, near midnight', () => {
    // 23:30 UTC on 17 Aug is already 00:30 on 18 Aug in British Summer Time.
    expect(workshopDateLabel(new Date('2026-08-17T23:30:00.000Z'), now)).toBe('Today')
  })
})

describe('rough amount', () => {
  it('trims, treats blank as not known, and never sharpens the wording', () => {
    expect(normalizeRoughAmount('  about half a box  ')).toBe('about half a box')
    expect(normalizeRoughAmount('   ')).toBeNull()
    expect(normalizeRoughAmount(null)).toBeNull()
    expect(normalizeRoughAmount(undefined)).toBeNull()
    expect(normalizeRoughAmount('4 or 5')).toBe('4 or 5')
  })

  it('copies the source leftover wording as-is when a move omits an amount', () => {
    expect(roughAmountFromSource('3', 'sheets')).toBe('3 sheets')
    expect(roughAmountFromSource('about 5', 'boards')).toBe('about 5 boards')
    expect(roughAmountFromSource('2', null)).toBe('2')
    expect(roughAmountFromSource(null, 'sheets')).toBeNull()
  })
})
