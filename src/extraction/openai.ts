import type { CandidateFactDraft, ExtractionInput, ExtractionProvider, ExtractionResult } from './types.js'
import { PILOT_DOMAIN_CONTEXT } from './pilot-domain-context.js'

const SCHEMA_VERSION = 'v2'
const MODEL = 'gpt-4o'

const BASE_PROMPT = `You are a job-memory extraction assistant for a UK building contractor.
Extract structured facts from the transcript of a voice note recorded on site.

Return a JSON object with a single key "facts" whose value is an array of candidate fact objects. Each fact object must have exactly these fields:
- factType: one of: ordered_material | used_material | leftover_material | supplier_delivery_note | customer_change | watch_out | labour | unclear
- summary: plain English summary (one sentence)
- materialName: string or null
- quantity: string or null (e.g. "12", "about 3", "half a bag")
- unit: string or null (e.g. "sheets", "packs", "metres")
- supplierName: string or null
- deliveryTiming: string or null
- locationOrUse: string or null (where material was used or delivered to)
- costAmount: string or null (stated cost value as decimal string without currency symbol, e.g. "5", "5.50", "40")
- costCurrency: string or null ("GBP" when pounds, £, or quid is used; null if unclear)
- costQualifier: "each" | "total" | "approx" | "unknown" | "per_hour" | null ("each" for per-unit cost, "total" for overall cost, "per_hour" for an hourly labour rate, "approx" for uncertain cost)
- totalCostAmount: string or null (stated or safely derivable total cost as decimal string; only set when total is explicit, quantity × unit-cost is unambiguous, or labour hours × hourly rate is unambiguous)
- labourHours: string or null (decimal hours worked for a labour fact, e.g. "6", "8", "3.5"; null otherwise. If hours cannot be safely converted, e.g. "half a day", leave null and keep the phrase in summary/labourTask)
- labourPerson: string or null (person, crew, or role for a labour fact, e.g. "Tom", "two of us", "electrician")
- labourTask: string or null (work area or task for a labour fact, e.g. "fitting cladding", "electrics")
- happenedAt: string or null (the day the fact happened, as YYYY-MM-DD. The user message states the date the note was recorded — resolve spoken day words against it: "today" is the recorded date, "yesterday" is the day before, and an explicit date like "Monday the 6th" is the matching calendar date. null when no day or date is spoken. Never guess a day from vague language like "last week".)
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

Labour:
- Use factType "labour" for time worked, e.g. "spent six hours fitting the cladding", "Tom did eight hours on electrics", "labour on the roof came to £600". Never classify labour as ordered_material.
- Put hours in labourHours, the task/area in labourTask, and the person/crew/role in labourPerson — do not put labour hours in quantity/unit.
- For an hourly rate use costQualifier "per_hour" with costAmount as the rate; set totalCostAmount only when hours × rate is unambiguous.
- For a stated total labour cost use costQualifier "total" with costAmount/totalCostAmount as the total.
- Labour with no rate or total is still a valid labour fact — leave cost fields null.
- When several people are mentioned, emit one labour fact per person — never a merged summary fact. "Mike 4 hours, Kurt 6" is two labour facts: Mike with labourHours "4" and Kurt with labourHours "6".
- A spoken day for labour ("yesterday", "on Monday") goes in happenedAt resolved against the recorded date; leave happenedAt null when no day is said.

Examples:
- "Spent six hours fitting the cladding today." -> { "factType": "labour", "summary": "Spent 6 hours fitting the cladding", "labourHours": "6", "labourTask": "fitting cladding", "labourPerson": null, "happenedAt": <the recorded date>, "costAmount": null, "costCurrency": null, "costQualifier": null, "totalCostAmount": null }
- "Tom did eight hours on electrics yesterday at £35 an hour." -> { "factType": "labour", "summary": "Tom did 8 hours on electrics at £35 an hour", "labourHours": "8", "labourTask": "electrics", "labourPerson": "Tom", "happenedAt": <the day before the recorded date>, "costAmount": "35", "costCurrency": "GBP", "costQualifier": "per_hour", "totalCostAmount": "280" }
- "Labour on the roof came to £600." -> { "factType": "labour", "summary": "Labour on the roof came to £600", "labourHours": null, "labourTask": "roof", "labourPerson": null, "happenedAt": null, "costAmount": "600", "costCurrency": "GBP", "costQualifier": "total", "totalCostAmount": "600" }
- "Mike 4 hours, Kurt 6." -> two facts: { "factType": "labour", "summary": "Mike worked 4 hours", "labourPerson": "Mike", "labourHours": "4", "labourTask": null, "happenedAt": null } and { "factType": "labour", "summary": "Kurt worked 6 hours", "labourPerson": "Kurt", "labourHours": "6", "labourTask": null, "happenedAt": null }

- Return { "facts": [] } if the transcript contains no site-relevant job facts
- Return only a valid JSON object with the "facts" key, no surrounding text or markdown`

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
