// Backend-owned feature gates.
//
// The backend is the source of truth for whether a feature's writes are allowed.
// A frontend flag (PostHog or otherwise) can only decide whether UI is shown —
// it can never be the thing that stops a request being recorded, because the API
// is reachable without the UI.
//
// Read at call time rather than module load so a deploy-time env change (and a
// test toggling the flag) takes effect without a rebuilt module graph.

// Explicit opt-in only: anything other than a recognised truthy value is off.
// An unset, empty, misspelled or half-configured flag therefore fails closed.
function enabled(value: string | undefined): boolean {
  if (value == null) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

// Supplier account settlement (aggregate cross-job supplier payments).
// Default OFF. Gates the settlement WRITE routes only — recording a payment,
// changing its date, undoing it. Reads stay available so an already-recorded
// receipt and the account payment history never become unreachable.
export function isSupplierAccountSettlementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.SUPPLIER_ACCOUNT_SETTLEMENT_ENABLED)
}
