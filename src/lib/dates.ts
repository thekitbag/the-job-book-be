// UK local-day semantics for effective ("happened") dates in the pilot.
// The pilot user works in the UK, so "today"/"yesterday" and day grouping use
// the Europe/London calendar day, and date-only values are stored as local
// noon so the intended day survives UTC round-trips in either DST offset.
//
// Pure module: no Prisma, no route/service imports.

const UK_TIME_ZONE = 'Europe/London'

const DAY_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

const ukDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: UK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const ukHourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: UK_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
})

// The UK local calendar day of an instant, as YYYY-MM-DD.
export function ukLocalDayString(instant: Date): string {
  return ukDayFormat.format(instant)
}

// 12:00 Europe/London on the given YYYY-MM-DD day, as a Date. Local noon keeps
// the intended day stable whichever timezone later renders the timestamp.
export function ukLocalNoon(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  // Start from UTC noon, then shift by the London offset at that moment
  // (London is UTC+0 or UTC+1, so London's hour at UTC-noon is 12 or 13).
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12))
  const londonHour = Number(ukHourFormat.format(utcNoon))
  return new Date(utcNoon.getTime() - (londonHour - 12) * 60 * 60 * 1000)
}

// Shift a YYYY-MM-DD day string by whole days (calendar arithmetic, DST-safe).
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days, 12))
  return shifted.toISOString().slice(0, 10)
}

// Resolve an extraction draft's happenedAt value to a stored timestamp:
//   · full ISO datetime → that instant unchanged
//   · YYYY-MM-DD → UK local noon of that day
//   · "today" / "yesterday" → resolved against the UK local day the source
//     note was captured, at local noon
//   · anything else → null (never guess a day from unresolvable language)
export function resolveDraftHappenedAt(
  value: string | null | undefined,
  noteCapturedAt: Date,
): Date | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  const lower = trimmed.toLowerCase()
  if (lower === 'today') return ukLocalNoon(ukLocalDayString(noteCapturedAt))
  if (lower === 'yesterday') return ukLocalNoon(shiftDay(ukLocalDayString(noteCapturedAt), -1))

  if (DAY_ONLY_RE.test(trimmed)) return ukLocalNoon(trimmed)

  // Full ISO datetime (must contain a time component to be treated as one)
  if (trimmed.includes('T')) {
    const parsed = new Date(trimmed)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  return null
}
