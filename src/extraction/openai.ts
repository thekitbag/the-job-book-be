import type { CandidateFactDraft, ExtractionInput, ExtractionProvider, ExtractionResult } from './types.js'
import { PILOT_DOMAIN_CONTEXT } from './pilot-domain-context.js'

const SCHEMA_VERSION = 'v1'
const MODEL = 'gpt-4o'

const BASE_PROMPT = `You are a job-memory extraction assistant for a UK building contractor.
Extract structured facts from the transcript of a voice note recorded on site.

Return a JSON object with a single key "facts" whose value is an array of candidate fact objects. Each fact object must have exactly these fields:
- factType: one of: ordered_material | used_material | leftover_material | supplier_delivery_note | customer_change | watch_out | unclear
- summary: plain English summary (one sentence)
- materialName: string or null
- quantity: string or null (e.g. "12", "about 3", "half a bag")
- unit: string or null (e.g. "sheets", "packs", "metres")
- supplierName: string or null
- deliveryTiming: string or null
- locationOrUse: string or null (where material was used or delivered to)
- costAmount: string or null (stated cost value as decimal string without currency symbol, e.g. "5", "5.50", "40")
- costCurrency: string or null ("GBP" when pounds, £, or quid is used; null if unclear)
- costQualifier: "each" | "total" | "approx" | "unknown" | null ("each" for per-unit cost, "total" for overall cost, "approx" for uncertain cost)
- totalCostAmount: string or null (stated or safely derivable total cost as decimal string; only set when total is explicit or quantity × unit-cost is unambiguous)
- confidenceLabel: "high" | "medium" | "low"
- confidenceReason: short explanation of why this confidence level was chosen
- uncertaintyFlags: array of strings, e.g. ["approximate_quantity", "supplier_uncertain", "material_uncertain", "date_uncertain", "cost_uncertain"]

Rules:
- Split mixed content into separate facts — one object per distinct item
- Use factType "unclear" for ambiguous statements where the fact type cannot be determined
- Use low confidence and add uncertaintyFlags for approximate language: "probably", "about", "I think", "maybe", "roughly"
- Do not infer quantities, suppliers, dates, or other details not stated in the transcript
- For cost: only extract costAmount when a price is clearly stated; add "cost_uncertain" when cost language is approximate or ambiguous
- Do not store money as floating point — use decimal strings (e.g. "5.50" not 5.5)
- Return { "facts": [] } if the transcript contains no site-relevant job facts
- Return only a valid JSON object with the "facts" key, no surrounding text or markdown`

export const SYSTEM_PROMPT = `${BASE_PROMPT}\n\n${PILOT_DOMAIN_CONTEXT}`

export class OpenAIExtractionProvider implements ExtractionProvider {
  readonly name = 'openai'
  readonly model = MODEL

  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async extractFacts(input: ExtractionInput): Promise<ExtractionResult> {
    const userPrompt = `Job: ${input.jobContext.title} (${input.jobContext.jobType})\n\nTranscript:\n${input.transcriptText}`

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
