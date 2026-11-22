import type { CandidateFactDraft, ExtractionInput, ExtractionProvider, ExtractionResult } from './types.js'

export const FAKE_EXTRACTION_SCHEMA_VERSION = 'v3-job-memory'

export const FAKE_EXTRACTION_FACTS: CandidateFactDraft[] = [
  {
    factType: 'ordered_material',
    summary: 'Ordered 12 sheets of plasterboard from Jewson, arriving tomorrow morning',
    materialName: 'plasterboard',
    quantity: '12',
    unit: 'sheets',
    supplierName: 'Jewson',
    deliveryTiming: 'tomorrow morning',
    confidenceLabel: 'high',
    confidenceReason: 'Stated explicitly with quantity, supplier, and delivery time',
    uncertaintyFlags: [],
  },
  {
    factType: 'ordered_material',
    summary: 'Bought 8 bags of hardcore from Jewson',
    materialName: 'hardcore',
    quantity: '8',
    unit: 'bags',
    supplierName: 'Jewson',
    confidenceLabel: 'medium',
    confidenceReason: 'Stated with quantity and supplier',
    uncertaintyFlags: [],
  },
  {
    factType: 'leftover_material',
    summary: 'Probably three insulation packs left',
    materialName: 'insulation packs',
    quantity: '3',
    unit: 'packs',
    confidenceLabel: 'low',
    confidenceReason: 'Approximate — "probably" used',
    uncertaintyFlags: ['approximate_quantity'],
  },
  {
    factType: 'labour',
    summary: 'Spent 6 hours fitting the cladding',
    labourHours: '6',
    labourTask: 'fitting cladding',
    confidenceLabel: 'high',
    confidenceReason: 'Hours and task stated; no cost mentioned',
    uncertaintyFlags: [],
  },
  {
    factType: 'labour',
    summary: 'Tom did 8 hours on electrics',
    labourHours: '8',
    labourTask: 'electrics',
    labourPerson: 'Tom',
    confidenceLabel: 'high',
    confidenceReason: 'Hours, person and task stated',
    uncertaintyFlags: [],
  },
]

export class FakeExtractionProvider implements ExtractionProvider {
  readonly name = 'fake'
  readonly model = 'fake-v3-job-memory'

  async extractFacts(_input: ExtractionInput): Promise<ExtractionResult> {
    return {
      facts: structuredClone(FAKE_EXTRACTION_FACTS),
      schemaVersion: FAKE_EXTRACTION_SCHEMA_VERSION,
    }
  }
}

export class FailingExtractionProvider implements ExtractionProvider {
  readonly name = 'fake-failing'
  readonly model = 'fake-v3-job-memory'

  async extractFacts(_input: ExtractionInput): Promise<ExtractionResult> {
    throw { code: 'EXTRACTION_PROVIDER_ERROR', message: 'Simulated extraction provider failure' }
  }
}
