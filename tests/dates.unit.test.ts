// UK local-day semantics for labour effective dates: day strings, local-noon
// timestamps (avoiding timezone day drift), and draft happenedAt resolution
// relative to the source note capture date.
import { describe, it, expect } from 'vitest'
import { ukLocalDayString, ukLocalNoon, resolveDraftHappenedAt } from '../src/lib/dates.js'

describe('ukLocalDayString', () => {
  it('returns the UK local calendar day for a UTC instant in summer (BST +1)', () => {
    // 23:30 UTC on 8 July is 00:30 on 9 July in London
    expect(ukLocalDayString(new Date('2026-07-08T23:30:00.000Z'))).toBe('2026-07-09')
    expect(ukLocalDayString(new Date('2026-07-08T09:00:00.000Z'))).toBe('2026-07-08')
  })

  it('returns the UK local calendar day in winter (GMT +0)', () => {
    expect(ukLocalDayString(new Date('2026-01-10T23:30:00.000Z'))).toBe('2026-01-10')
  })
})

describe('ukLocalNoon', () => {
  it('returns 12:00 London time for a summer date (11:00 UTC)', () => {
    expect(ukLocalNoon('2026-07-08').toISOString()).toBe('2026-07-08T11:00:00.000Z')
  })

  it('returns 12:00 London time for a winter date (12:00 UTC)', () => {
    expect(ukLocalNoon('2026-01-10').toISOString()).toBe('2026-01-10T12:00:00.000Z')
  })

  it('round-trips through ukLocalDayString without day drift', () => {
    expect(ukLocalDayString(ukLocalNoon('2026-07-08'))).toBe('2026-07-08')
    expect(ukLocalDayString(ukLocalNoon('2026-01-10'))).toBe('2026-01-10')
  })
})

describe('resolveDraftHappenedAt', () => {
  const capturedAt = new Date('2026-07-08T09:00:00.000Z') // UK day 2026-07-08

  it('returns null for null/undefined/empty', () => {
    expect(resolveDraftHappenedAt(null, capturedAt)).toBeNull()
    expect(resolveDraftHappenedAt(undefined, capturedAt)).toBeNull()
    expect(resolveDraftHappenedAt('', capturedAt)).toBeNull()
  })

  it('resolves a date-only value to UK local noon of that day', () => {
    expect(resolveDraftHappenedAt('2026-07-06', capturedAt)?.toISOString()).toBe('2026-07-06T11:00:00.000Z')
  })

  it('passes through a full ISO datetime unchanged', () => {
    expect(resolveDraftHappenedAt('2026-07-06T09:30:00.000Z', capturedAt)?.toISOString()).toBe(
      '2026-07-06T09:30:00.000Z',
    )
  })

  it('resolves "today" to the capture day at UK local noon', () => {
    expect(resolveDraftHappenedAt('today', capturedAt)?.toISOString()).toBe('2026-07-08T11:00:00.000Z')
  })

  it('resolves "yesterday" relative to the source note capture date', () => {
    expect(resolveDraftHappenedAt('yesterday', capturedAt)?.toISOString()).toBe('2026-07-07T11:00:00.000Z')
  })

  it('resolves "yesterday" against the UK local capture day across the midnight boundary', () => {
    // 23:30 UTC on 8 July is already 9 July in London, so yesterday is 8 July
    const lateCapture = new Date('2026-07-08T23:30:00.000Z')
    expect(resolveDraftHappenedAt('yesterday', lateCapture)?.toISOString()).toBe('2026-07-08T11:00:00.000Z')
  })

  it('returns null for unresolvable values rather than guessing', () => {
    expect(resolveDraftHappenedAt('next week', capturedAt)).toBeNull()
    expect(resolveDraftHappenedAt('sometime', capturedAt)).toBeNull()
  })
})
