export type FactType =
  | 'ordered_material'
  | 'used_material'
  | 'leftover_material'
  | 'supplier_delivery_note'
  | 'customer_change'
  | 'watch_out'
  | 'unclear'

export type ConfidenceLabel = 'high' | 'medium' | 'low'

export type CostQualifier = 'each' | 'total' | 'approx' | 'unknown'

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
  confidenceLabel: ConfidenceLabel
  confidenceReason: string
  uncertaintyFlags: string[]
}

export interface ExtractionInput {
  transcriptId: string
  noteId: string
  jobId: string
  transcriptText: string
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
