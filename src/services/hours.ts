import { Prisma } from '@prisma/client'
import { ukLocalDayString } from '../lib/dates.js'

type Entry = {
  id: string
  labourPersonId: string | null
  labourPerson: string | null
  labourHours: string | null
  labourTask: string | null
  happenedAt: Date | null
  createdAt: Date
  isManual: boolean
  sourceFact: { sourceNote: { capturedAt: Date } } | null
}
export function buildHours(
  items: Entry[],
  accountName: string,
  linkedNames: Map<string, string>,
) {
  const resolved = items
    .filter((m) => m.labourHours != null)
    .map((m) => ({
      m,
      name:
        (m.labourPersonId && linkedNames.get(m.labourPersonId)) ||
        (!m.labourPerson?.trim() ||
        /^(me|i|myself)$/i.test(m.labourPerson.trim())
          ? accountName
          : m.labourPerson.trim()),
    }))
  const spellings = new Map<string, Map<string, number>>()
  for (const { name } of resolved) {
    const key = name.toLowerCase()
    const group = spellings.get(key) ?? new Map<string, number>()
    group.set(name, (group.get(name) ?? 0) + 1)
    spellings.set(key, group)
  }
  const canonical = new Map(
    resolved.flatMap(({ m, name }) =>
      m.labourPersonId && linkedNames.has(m.labourPersonId)
        ? [[name.toLowerCase(), name] as const]
        : [],
    ),
  )
  const names = new Map(
    [...spellings].map(([key, variants]) => [
      key,
      canonical.get(key) ??
        [...variants].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0][0],
    ]),
  )
  const people = new Map<string, Prisma.Decimal>()
  const days = new Map<
    string,
    {
      date: string
      total: Prisma.Decimal
      entries: {
        memoryItemId: string
        person: string
        hours: string
        task: string | null
        isManual: boolean
      }[]
    }
  >()
  let total = new Prisma.Decimal(0)
  for (const { m, name } of resolved) {
    const hours = new Prisma.Decimal(m.labourHours!)
    const person = names.get(name.toLowerCase())!
    total = total.add(hours)
    people.set(person, (people.get(person) ?? new Prisma.Decimal(0)).add(hours))
    const date = ukLocalDayString(
      m.happenedAt ?? m.sourceFact?.sourceNote.capturedAt ?? m.createdAt,
    )
    const day = days.get(date) ?? {
      date,
      total: new Prisma.Decimal(0),
      entries: [],
    }
    day.total = day.total.add(hours)
    day.entries.push({
      memoryItemId: m.id,
      person,
      hours: m.labourHours!,
      task: m.labourTask,
      isManual: m.isManual,
    })
    days.set(date, day)
  }
  return {
    totalHours: total.toString(),
    people: [...people]
      .sort((a, b) => b[1].comparedTo(a[1]) || a[0].localeCompare(b[0]))
      .map(([name, hours]) => ({ name, hours: hours.toString() })),
    days: [...days.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((d) => ({
        date: d.date,
        totalHours: d.total.toString(),
        entries: d.entries,
      })),
  }
}
