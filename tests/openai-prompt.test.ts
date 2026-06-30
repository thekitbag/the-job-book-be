import { describe, it, expect } from 'vitest'
import { SYSTEM_PROMPT } from '../src/extraction/openai.js'

describe('OpenAI extraction prompt — labour', () => {
  it('documents the labour fact type and fields', () => {
    expect(SYSTEM_PROMPT).toContain('labour')
    expect(SYSTEM_PROMPT).toContain('per_hour')
    expect(SYSTEM_PROMPT).toContain('labourHours')
    expect(SYSTEM_PROMPT).toContain('labourPerson')
    expect(SYSTEM_PROMPT).toContain('labourTask')
  })

  it('includes the labour examples from the spec', () => {
    expect(SYSTEM_PROMPT).toContain('fitting the cladding')
    expect(SYSTEM_PROMPT).toContain('£35 an hour')
    expect(SYSTEM_PROMPT).toContain('Labour on the roof')
  })
})

describe('OpenAI extraction prompt — pilot supplier glossary', () => {
  it('includes all pilot supplier names', () => {
    expect(SYSTEM_PROMPT).toContain('Jewson')
    expect(SYSTEM_PROMPT).toContain('Travis Perkins')
    expect(SYSTEM_PROMPT).toContain('Screwfix')
    expect(SYSTEM_PROMPT).toContain('Toolstation')
    expect(SYSTEM_PROMPT).toContain('Selco')
  })
})

describe('OpenAI extraction prompt — pilot material/trade glossary', () => {
  it('includes all pilot material and trade terms', () => {
    expect(SYSTEM_PROMPT).toContain('OSB')
    expect(SYSTEM_PROMPT).toContain('plasterboard')
    expect(SYSTEM_PROMPT).toContain('insulation')
    expect(SYSTEM_PROMPT).toContain('Celotex')
    expect(SYSTEM_PROMPT).toContain('battens')
    expect(SYSTEM_PROMPT).toContain('cladding')
    expect(SYSTEM_PROMPT).toContain('screws')
  })
})

describe('OpenAI extraction prompt — likely mishear examples', () => {
  it('lists supplier mishear variants', () => {
    expect(SYSTEM_PROMPT).toContain("Duesen's")
    expect(SYSTEM_PROMPT).toContain('juice and')
    expect(SYSTEM_PROMPT).toContain('screw fits')
    expect(SYSTEM_PROMPT).toContain('two station')
    expect(SYSTEM_PROMPT).toContain('traffic Perkins')
  })

  it('lists material mishear variants', () => {
    expect(SYSTEM_PROMPT).toContain('USB')
    expect(SYSTEM_PROMPT).toContain('OSP')
    expect(SYSTEM_PROMPT).toContain('sellotex')
    expect(SYSTEM_PROMPT).toContain('plastic board')
    expect(SYSTEM_PROMPT).toContain('buttons')
    expect(SYSTEM_PROMPT).toContain('clouding')
  })
})

describe('OpenAI extraction prompt — uncertainty rules', () => {
  it('instructs model to use medium confidence for corrected mishears', () => {
    expect(SYSTEM_PROMPT).toContain('medium')
  })

  it('instructs model to add supplier_uncertain flag', () => {
    expect(SYSTEM_PROMPT).toContain('supplier_uncertain')
  })

  it('instructs model to add material_uncertain flag', () => {
    expect(SYSTEM_PROMPT).toContain('material_uncertain')
  })

  it('does not use the old supplier_unconfirmed flag name — vocabulary must match the guard/harness', () => {
    expect(SYSTEM_PROMPT).not.toContain('supplier_unconfirmed')
  })
})

describe('OpenAI extraction prompt — weak-context guardrail', () => {
  it('tells the model not to invent glossary terms in weak context', () => {
    const lower = SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/weak.{0,30}context|do not force|cannot.{0,50}null/)
  })

  it('tells the model to leave supplier or material null when context is weak', () => {
    expect(SYSTEM_PROMPT).toContain('null')
  })
})

describe('OpenAI extraction prompt — Jason person-name trap', () => {
  it('names Jason explicitly as a person-name trap', () => {
    expect(SYSTEM_PROMPT).toContain('Jason')
  })

  it('says Jason must not be corrected to Jewson', () => {
    expect(SYSTEM_PROMPT).toContain('Jewson')
    const jasonIdx = SYSTEM_PROMPT.indexOf('Jason')
    const jewsonAfterJason = SYSTEM_PROMPT.indexOf('Jewson', jasonIdx)
    expect(jewsonAfterJason).toBeGreaterThan(jasonIdx)
  })

  it('warns against turning person/customer names into supplier names', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/person.{0,20}name|customer.{0,20}name|neighbour.{0,20}name/)
  })
})
