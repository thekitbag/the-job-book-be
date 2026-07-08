export type FactType =
  | 'ordered_material'
  | 'used_material'
  | 'leftover_material'
  | 'supplier_delivery_note'
  | 'customer_change'
  | 'watch_out'
  | 'labour'
  | 'unclear'

export type ConfidenceLabel = 'high' | 'medium' | 'low'

export type CostQualifier = 'each' | 'total' | 'approx' | 'unknown' | 'per_hour'

export interface CandidateFactDraft {
  factType: FactType
  summary: string
  materialName?: string
  quantity?: string
  unit?: string
  supplierName?: string
  deliveryTiming?: string
  locationOrUse?: string
  costAmount?: string
  costCurrency?: string
  costQualifier?: CostQualifier
  totalCostAmount?: string
  labourHours?: string
  labourPerson?: string
  labourTask?: string
  // Effective day the fact happened: resolved YYYY-MM-DD, full ISO datetime,
  // or a relative "today"/"yesterday" token; the worker resolves it against
  // the source note capture date.
  happenedAt?: string | null
  confidenceLabel: ConfidenceLabel
  confidenceReason: string
  uncertaintyFlags: string[]
}

export interface ExtractionInput {
  transcriptId: string
  noteId: string
  jobId: string
  transcriptText: string
  noteCapturedAt: Date
  jobContext: { title: string; jobType: string }
}

export interface ExtractionResult {
  facts: CandidateFactDraft[]
  schemaVersion: string
  providerResponseId?: string
}

export interface ExtractionProvider {
  readonly name: string
  readonly model: string
  extractFacts(input: ExtractionInput): Promise<ExtractionResult>
}
