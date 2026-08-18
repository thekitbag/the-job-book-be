// The shared vocabulary of the supplier account: what counts as a purchase on
// one, how a supplier is identified, how its group id is derived, and how its
// figures are written for a cross-job screen. Owned here rather than in either
// service so the read model (`book-money`) and the write side
// (`supplier-payments`) cannot drift apart — and so neither has to import the
// other.
//
// Pure module: no Prisma, no route/service imports.
import { createHash } from 'crypto'
import { STRICT_DECIMAL_RE } from './cost-utils.js'

// Supplier-account eligibility, conservative by design (see the cross-job Money
// spec's trust boundary). Only remembered bought/ordered material is treated as
// a purchase on a supplier account. BUDGET_COST is deliberately NOT included:
// the model has no discriminator proving a generic budget cost is a
// supplier/merchant purchase rather than plant hire, a subcontractor or another
// job cost, and guessing would inflate what Mike thinks he owes a merchant.
export const SUPPLIER_ACCOUNT_MEMORY_TYPES = ['ORDERED_MATERIAL'] as const

export const SUPPLIER_NEEDED_LABEL = 'Supplier needed'

export type BookJobStatus = 'planning' | 'started' | 'finished'

export const JOB_STATUS_LABELS: Record<string, string> = {
  planning: 'Planning',
  started: 'In progress',
  finished: 'Finished',
}

// Cross-job labels are prose read at a glance next to a frontend-formatted
// figure, so they carry thousands separators ("can't be in the £6,088" — the
// spec's own example). Job-level Money/Budget keep their plain `£${amount}`
// style; the difference is display only. Amount FIELDS stay raw decimal
// strings everywhere so the client formats its own figures.
const gbpOptions = { style: 'currency', currency: 'GBP' } as const
const gbpWhole = new Intl.NumberFormat('en-GB', { ...gbpOptions, minimumFractionDigits: 0, maximumFractionDigits: 0 })
// Pence show in full or not at all — "£4,870.50", never "£4,870.5".
const gbpPence = new Intl.NumberFormat('en-GB', { ...gbpOptions, minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function gbp(amount: string): string {
  // Never invent a figure: anything not a plain decimal is shown as stored.
  if (!STRICT_DECIMAL_RE.test(amount)) return `£${amount}`
  const n = Number(amount)
  return Number.isInteger(n) ? gbpWhole.format(n) : gbpPence.format(n)
}

export const round2 = (n: number) => String(Math.round(n * 100) / 100)

// Opaque but deterministic group id. Derived from the owner + the exact stored
// supplier key so the same supplier group keeps the same id between reads.
// Never a supplier database id — there is no supplier record in this model.
export function computeGroupId(userId: string, supplierKey: string): string {
  const h = createHash('sha256').update(`${userId}:supplier:${supplierKey}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// The group id a named supplier account has in the cross-job read model.
// Settlement validates the client's `supplierGroupId` against it, so a payment
// can never be recorded against a supplier group the client only thinks it is
// looking at.
export function supplierGroupIdFor(userId: string, supplierName: string): string {
  return computeGroupId(userId, `named:${supplierName}`)
}

// Supplier identity is the trusted stored field, trimmed for display only.
// Similar names are never merged: `Sydenhams`, `Sydenham's` and `Sydenhams Ltd`
// stay three groups until the model gains a real canonical supplier identity.
export function normalizeSupplier(supplierName: string | null): string | null {
  const trimmed = supplierName?.trim()
  return trimmed ? trimmed : null
}

export function quantityLabel(quantity: string | null, unit: string | null): string | null {
  const q = quantity?.trim()
  if (!q) return null
  const u = unit?.trim()
  return u ? `${q} ${u}` : q
}
