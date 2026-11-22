import type { CandidateFactDraft, ExtractionInput, ExtractionProvider, ExtractionResult } from './types.js'
import { PILOT_DOMAIN_CONTEXT } from './pilot-domain-context.js'

export const EXTRACTION_SCHEMA_VERSION = 'v3-job-memory'
const SCHEMA_VERSION = EXTRACTION_SCHEMA_VERSION
const MODEL = 'gpt-4o'

const BASE_PROMPT = `You extract job memory from a UK builder's site voice note.
Return only a JSON object {"facts": [...]}. Every candidate fact has these fields:
- factType: ordered_material | used_material | leftover_material | returned_material | labour | unclear
- summary: one plain English sentence about memory only, with no prices, currency or money
- materialName, quantity, unit, supplierName, deliveryTiming, locationOrUse: string or null
- labourHours: decimal hours as a string or null
- labourPerson: named person, crew or role as a string, or null
- labourTask: task or work area as a string or null
- happenedAt: YYYY-MM-DD or null; resolve today/yesterday/explicit dates against the recorded date in the user message. Never guess vague dates.
- confidenceLabel: high | medium | low
- confidenceReason: short reason
- uncertaintyFlags: string array

Rules:
- Extract only materials, hours and unclear memory. Do not emit budget_cost, supplier_delivery_note, customer_change, watch_out or general_note facts. The recording itself is the note.
- Never extract a price, rate, cost field, refund or payment, including in summaries. A price-only note like "Skip hire, two fifty" returns {"facts":[]}.
- "10 sheets of OSB from Jewson, £240" gives exactly one ordered_material: materialName OSB, quantity "10", unit "sheets", supplierName Jewson; no price in any field.
- For a plain count or measurement put only the number as a decimal string in quantity and the unit separately: "two metres" means quantity "2", unit "metres"; "three packs" means quantity "3", unit "packs".
- Words like "probably" or "I think" belong in uncertaintyFlags (approximate_quantity) and low confidence, not in quantity.
- For a fraction or rough amount, quantity retains the whole rough phrase, for example "half a bag" (unit "bags"), "one and a bit" or "about half a pallet". Never shorten "half a bag" to "half".
- Preserve rough quantities ("about half a pallet", "one and a bit"). Never force false precision. Add appropriate uncertainty flags and use low confidence for uncertainty.
- Do not infer missing quantities, suppliers, people or dates. If meaning is unclear, use unclear rather than guessing.
- Split distinct material observations. Bought or collected materials use ordered_material. Materials sent back use returned_material.
- For labour emit one fact per person and day: "Mike 6, Kurt 4" means Mike labourHours "6" and Kurt labourHours "4", never one combined entry.
- "Me seven hours", "I did six" and hours without a person set labourPerson to null. Never guess the account name.
- Labour hours belong in labourHours, never quantity/unit. Do not infer hours from "half a day"; keep the phrase in labourTask with an uncertainty flag.
- "Picked up ten sheets of OSB from Jewson, two hundred and forty quid. Me seven hours, Kurt six." gives three facts: OSB 10 sheets from Jewson, null person 7 hours, Kurt 6 hours.
- Keep material memory even inside an instruction, delivery or change. "Use the spare cladding from the workshop before ordering more" gives leftover_material, materialName "cladding", locationOrUse "workshop". "Cancel the order for the extra OSB; we found enough in the workshop" keeps the leftover_material OSB in the workshop, without a separate change fact. "Travis Perkins dropped the hardcore at the front gate" is material memory (ordered_material), not a note fact.
- Transcript words about deliveries, changes or warnings are kept in the recording, not separate note facts.
- Return {"facts":[]} for content with no materials, hours or unclear job memory.`

export const SYSTEM_PROMPT = `${BASE_PROMPT}\n\n${PILOT_DOMAIN_CONTEXT}`

// The recorded date (UK local day) anchors relative-day resolution in the model.
export function buildUserPrompt(input: ExtractionInput): string {
  const recordedDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(input.noteCapturedAt)
  return `Job: ${input.jobContext.title} (${input.jobContext.jobType})\nNote recorded on: ${recordedDay}\n\nTranscript:\n${input.transcriptText}`
}

export class OpenAIExtractionProvider implements ExtractionProvider {
  readonly name = 'openai'
  readonly model = MODEL

  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async extractFacts(input: ExtractionInput): Promise<ExtractionResult> {
    const userPrompt = buildUserPrompt(input)

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw { code: 'EXTRACTION_HTTP_ERROR', message: `OpenAI API error ${response.status}: ${text}` }
    }

    const data = (await response.json()) as {
      id?: string
      choices: Array<{ message: { content: string } }>
    }

    const raw = data.choices[0]?.message?.content ?? '[]'
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw { code: 'EXTRACTION_PARSE_ERROR', message: `Failed to parse extraction response: ${raw.slice(0, 200)}` }
    }

    // Accept both { facts: [...] } wrapper and bare array
    const factsArray = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown }).facts ?? []
    if (!Array.isArray(factsArray)) {
      throw { code: 'EXTRACTION_PARSE_ERROR', message: 'Extraction response was not an array' }
    }

    return {
      facts: factsArray as CandidateFactDraft[],
      schemaVersion: SCHEMA_VERSION,
      providerResponseId: data.id,
    }
  }
}
