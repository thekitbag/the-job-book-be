import { describe, it, expect } from 'vitest'
import { applyPilotCorrectionGuard } from '../src/extraction/pilot-correction-guard.js'
import type { CandidateFactDraft } from '../src/extraction/types.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const ORDER_TRANSCRIPT = 'Ordered twenty bags of sand from Duesen\'s for Monday.'
const BOARD_TRANSCRIPT = 'Used six USB boards on the back wall.'
const FRAMING_TRANSCRIPT = 'Secured all the buttons along the top of the frame.'
const ELEVATION_TRANSCRIPT = 'Started the clouding on the south elevation.'
const WEAK_TRANSCRIPT = 'Had a chat with someone about the project.'
const JEWSON_TRANSCRIPT = 'Picked up twelve sheets of plasterboard from Jewson.'

const JOB = { title: 'Garden room', jobType: 'garden_room' }

function makeFact(overrides: Partial<CandidateFactDraft> = {}): CandidateFactDraft {
  return {
    factType: 'ordered_material',
    summary: 'Test fact summary',
    confidenceLabel: 'high',
    confidenceReason: 'Explicit in transcript',
    uncertaintyFlags: [],
    ...overrides,
  }
}

function guard(facts: CandidateFactDraft[], transcript = ORDER_TRANSCRIPT): CandidateFactDraft[] {
  return applyPilotCorrectionGuard({ transcriptText: transcript, jobContext: JOB, facts })
}

// ── Supplier: canonical casing fix ───────────────────────────────────────────

describe('guard — canonical supplier casing', () => {
  it('fixes lower-case jewson to Jewson, keeps high confidence', () => {
    const [result] = guard([makeFact({ supplierName: 'jewson' })], JEWSON_TRANSCRIPT)
    expect(result.supplierName).toBe('Jewson')
    expect(result.confidenceLabel).toBe('high')
    expect(result.uncertaintyFlags).not.toContain('supplier_uncertain')
  })

  it('fixes upper-case JEWSON to Jewson', () => {
    const [result] = guard([makeFact({ supplierName: 'JEWSON' })], JEWSON_TRANSCRIPT)
    expect(result.supplierName).toBe('Jewson')
  })

  it('fixes Travis perkins to Travis Perkins', () => {
    const [result] = guard([makeFact({ supplierName: 'Travis perkins' })])
    expect(result.supplierName).toBe('Travis Perkins')
    expect(result.uncertaintyFlags).not.toContain('supplier_uncertain')
  })
})

// ── Supplier: safe aliases ────────────────────────────────────────────────────

describe('guard — safe supplier aliases (keep high confidence)', () => {
  it('jewsons → Jewson, keeps high confidence', () => {
    const [result] = guard([makeFact({ supplierName: 'jewsons' })], JEWSON_TRANSCRIPT)
    expect(result.supplierName).toBe('Jewson')
    expect(result.confidenceLabel).toBe('high')
  })

  it('screw fix → Screwfix, keeps high confidence', () => {
    const t = 'Ordered joist hangers from screw fix.'
    const [result] = guard([makeFact({ supplierName: 'screw fix' })], t)
    expect(result.supplierName).toBe('Screwfix')
    expect(result.confidenceLabel).toBe('high')
    expect(result.uncertaintyFlags).not.toContain('supplier_uncertain')
  })

  it('tool station → Toolstation, keeps high confidence', () => {
    const t = 'Ordered window fixings from tool station.'
    const [result] = guard([makeFact({ supplierName: 'tool station' })], t)
    expect(result.supplierName).toBe('Toolstation')
    expect(result.confidenceLabel).toBe('high')
  })
})

// ── Supplier: risky mishears ──────────────────────────────────────────────────

describe("guard — Duesen's → Jewson (risky mishear, strong context)", () => {
  it("corrects Duesen's to Jewson in order context", () => {
    const [result] = guard([makeFact({ supplierName: "Duesen's" })], ORDER_TRANSCRIPT)
    expect(result.supplierName).toBe('Jewson')
  })

  it('lowers confidence to at most medium', () => {
    const [result] = guard([makeFact({ supplierName: "Duesen's", confidenceLabel: 'high' })], ORDER_TRANSCRIPT)
    expect(result.confidenceLabel).toBe('medium')
  })

  it('adds supplier_uncertain flag', () => {
    const [result] = guard([makeFact({ supplierName: "Duesen's" })], ORDER_TRANSCRIPT)
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })

  it('updates confidenceReason to explain the correction', () => {
    const [result] = guard([makeFact({ supplierName: "Duesen's" })], ORDER_TRANSCRIPT)
    expect(result.confidenceReason).toContain('Jewson')
  })

  it('does not raise existing low confidence', () => {
    const [result] = guard([makeFact({ supplierName: "Duesen's", confidenceLabel: 'low' })], ORDER_TRANSCRIPT)
    expect(result.confidenceLabel).toBe('low')
  })
})

describe('guard — juice and → Jewson (risky mishear)', () => {
  it('corrects juice and to Jewson in strong context', () => {
    const t = 'Ordered twelve sheets of plasterboard from juice and, delivery tomorrow.'
    const [result] = guard([makeFact({ supplierName: 'juice and' })], t)
    expect(result.supplierName).toBe('Jewson')
    expect(result.confidenceLabel).toBe('medium')
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })

  it('clears juice and in weak context (no order language)', () => {
    const t = 'Had a chat with juice and about something.'
    const [result] = guard([makeFact({ supplierName: 'juice and', factType: 'unclear' })], t)
    expect(result.supplierName).toBeUndefined()
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })
})

describe('guard — traffic Perkins → Travis Perkins', () => {
  it('corrects traffic Perkins to Travis Perkins in supplier context', () => {
    const t = 'Picked up battens from traffic Perkins yesterday.'
    const [result] = guard([makeFact({ supplierName: 'traffic Perkins' })], t)
    expect(result.supplierName).toBe('Travis Perkins')
    expect(result.confidenceLabel).toBe('medium')
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })
})

describe('guard — screw fits → Screwfix (risky, not safe alias)', () => {
  it('corrects screw fits to Screwfix in order context', () => {
    const t = 'Ordered joist hangers from screw fits.'
    const [result] = guard([makeFact({ supplierName: 'screw fits' })], t)
    expect(result.supplierName).toBe('Screwfix')
    expect(result.confidenceLabel).toBe('medium')
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })
})

// ── Person-name trap ──────────────────────────────────────────────────────────

describe('guard — Jason must not become Jewson', () => {
  it('clears Jason from supplierName — does not correct to Jewson', () => {
    const t = 'Ordered six bags of cement from Jason, delivery Friday.'
    const [result] = guard([makeFact({ supplierName: 'Jason' })], t)
    expect(result.supplierName).toBeUndefined()
    expect(result.supplierName).not.toBe('Jewson')
  })

  it('adds supplier_uncertain flag for Jason', () => {
    const [result] = guard([makeFact({ supplierName: 'Jason' })])
    expect(result.uncertaintyFlags).toContain('supplier_uncertain')
  })

  it('lowers confidence for Jason', () => {
    const [result] = guard([makeFact({ supplierName: 'Jason', confidenceLabel: 'high' })])
    expect(result.confidenceLabel).toBe('medium')
  })
})

// ── Material: canonical casing fix ───────────────────────────────────────────

describe('guard — canonical material casing', () => {
  it('osb → OSB, keeps high confidence', () => {
    const [result] = guard([makeFact({ materialName: 'osb' })], BOARD_TRANSCRIPT)
    expect(result.materialName).toBe('OSB')
    expect(result.confidenceLabel).toBe('high')
    expect(result.uncertaintyFlags).not.toContain('material_uncertain')
  })

  it('CELOTEX → Celotex', () => {
    const [result] = guard([makeFact({ materialName: 'CELOTEX' })], 'Need insulation packs.')
    expect(result.materialName).toBe('Celotex')
    expect(result.uncertaintyFlags).not.toContain('material_uncertain')
  })
})

// ── Material: risky mishears ──────────────────────────────────────────────────

describe('guard — USB boards → OSB (risky mishear, board context)', () => {
  it('corrects USB boards to OSB in board/wall context', () => {
    const [result] = guard([makeFact({ materialName: 'USB boards' })], BOARD_TRANSCRIPT)
    expect(result.materialName).toBe('OSB')
  })

  it('adds material_uncertain and lowers confidence', () => {
    const [result] = guard([makeFact({ materialName: 'USB boards', confidenceLabel: 'high' })], BOARD_TRANSCRIPT)
    expect(result.confidenceLabel).toBe('medium')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })

  it('clears USB boards with no board context', () => {
    const [result] = guard([makeFact({ materialName: 'USB boards' })], WEAK_TRANSCRIPT)
    expect(result.materialName).toBeUndefined()
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })
})

describe('guard — sellotex insulation → Celotex', () => {
  it('corrects sellotex insulation to Celotex', () => {
    const t = 'Need three sellotex insulation packs, maybe four.'
    const [result] = guard([makeFact({ materialName: 'sellotex insulation' })], t)
    expect(result.materialName).toBe('Celotex')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
    expect(result.confidenceLabel).toBe('medium')
  })

  it('corrects sellotex alone (no insulation word in field)', () => {
    const t = 'Need three sellotex packs.'
    const [result] = guard([makeFact({ materialName: 'sellotex' })], t)
    expect(result.materialName).toBe('Celotex')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })
})

describe('guard — plastic board → plasterboard (strong context)', () => {
  it('corrects plastic board to plasterboard in sheet/jewson context', () => {
    const t = 'Ordered twelve sheets of plastic board from Jewson.'
    const [result] = guard([makeFact({ materialName: 'plastic board' })], t)
    expect(result.materialName).toBe('plasterboard')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
    expect(result.confidenceLabel).toBe('medium')
  })

  it('corrects plaster bored to plasterboard in wall context', () => {
    const t = 'Used plaster bored on the back wall.'
    const [result] = guard([makeFact({ materialName: 'plaster bored' })], t)
    expect(result.materialName).toBe('plasterboard')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })
})

describe('guard — buttons → battens (framing context only)', () => {
  it('corrects buttons to battens in frame context', () => {
    const [result] = guard([makeFact({ materialName: 'buttons' })], FRAMING_TRANSCRIPT)
    expect(result.materialName).toBe('battens')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })

  it('clears buttons without framing context', () => {
    const [result] = guard([makeFact({ materialName: 'buttons' })], WEAK_TRANSCRIPT)
    expect(result.materialName).toBeUndefined()
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })
})

describe('guard — clouding → cladding (elevation context only)', () => {
  it('corrects clouding to cladding in elevation context', () => {
    const [result] = guard([makeFact({ materialName: 'clouding' })], ELEVATION_TRANSCRIPT)
    expect(result.materialName).toBe('cladding')
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })

  it('clears clouding without elevation context', () => {
    const [result] = guard([makeFact({ materialName: 'clouding' })], WEAK_TRANSCRIPT)
    expect(result.materialName).toBeUndefined()
    expect(result.uncertaintyFlags).toContain('material_uncertain')
  })
})

// ── Summary sanitisation ──────────────────────────────────────────────────────

describe('guard — summary sanitisation', () => {
  it("replaces Duesen's with Jewson in summary when supplier is corrected", () => {
    const fact = makeFact({
      supplierName: "Duesen's",
      summary: "Ordered twenty bags of sand from Duesen's for Monday.",
    })
    const [result] = guard([fact], ORDER_TRANSCRIPT)
    expect(result.summary).toContain('Jewson')
    expect(result.summary).not.toContain("Duesen's")
  })

  it('replaces Jason with "supplier unclear" in summary when supplier is cleared', () => {
    const fact = makeFact({
      supplierName: 'Jason',
      summary: 'Ordered cement from Jason, delivery Friday.',
    })
    const [result] = guard([fact])
    expect(result.summary).toContain('supplier unclear')
    expect(result.summary).not.toContain('Jason')
  })

  it('replaces USB boards with OSB in summary when material is corrected', () => {
    const fact = makeFact({
      materialName: 'USB boards',
      summary: 'Used six USB boards on the back wall.',
    })
    const [result] = guard([fact], BOARD_TRANSCRIPT)
    expect(result.summary).toContain('OSB')
    expect(result.summary).not.toContain('USB boards')
  })

  it('replaces sellotex with Celotex in summary', () => {
    const t = 'Need three sellotex insulation packs.'
    const fact = makeFact({
      materialName: 'sellotex',
      summary: 'Need three sellotex insulation packs.',
    })
    const [result] = guard([fact], t)
    expect(result.summary).toContain('Celotex')
    expect(result.summary).not.toContain('sellotex')
  })

  it('leaves summary unchanged when no correction is made', () => {
    const fact = makeFact({
      supplierName: 'Jewson',
      materialName: 'plasterboard',
      summary: 'Ordered 12 sheets of plasterboard from Jewson.',
    })
    const [result] = guard([fact], JEWSON_TRANSCRIPT)
    expect(result.summary).toBe('Ordered 12 sheets of plasterboard from Jewson.')
  })
})

// ── Unrelated facts are left alone ───────────────────────────────────────────

describe('guard — unrelated supplier/material left unchanged', () => {
  it('does not modify a fact with an unknown supplier outside the glossary', () => {
    const fact = makeFact({ supplierName: 'Local Timber Supplies' })
    const [result] = guard([fact])
    expect(result.supplierName).toBe('Local Timber Supplies')
    expect(result.confidenceLabel).toBe('high')
    expect(result.uncertaintyFlags).toHaveLength(0)
  })

  it('does not modify a fact with an unknown material outside the glossary', () => {
    const fact = makeFact({ materialName: 'zinc flashing' })
    const [result] = guard([fact])
    expect(result.materialName).toBe('zinc flashing')
    expect(result.uncertaintyFlags).toHaveLength(0)
  })

  it('returns an empty array unchanged', () => {
    const result = guard([])
    expect(result).toHaveLength(0)
  })

  it('passes through facts with no supplier or material', () => {
    const fact = makeFact({ supplierName: undefined, materialName: undefined })
    const [result] = guard([fact])
    expect(result.confidenceLabel).toBe('high')
    expect(result.uncertaintyFlags).toHaveLength(0)
  })
})
