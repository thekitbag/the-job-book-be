import type { CandidateFactDraft, ExtractionInput, ExtractionProvider, ExtractionResult } from './types.js'

const SCHEMA_VERSION = 'v1'
const MODEL = 'gpt-4o'

const SYSTEM_PROMPT = `You are a job-memory extraction assistant for a UK building contractor.
Extract structured facts from the transcript of a voice note recorded on site.

Return a JSON array of candidate facts. Each fact object must have exactly these fields:
- factType: one of: ordered_material | used_material | leftover_material | supplier_delivery_note | customer_change | watch_out | unclear
- summary: plain English summary (one sentence)
- materialName: string or null
- quantity: string or null (e.g. "12", "about 3", "half a bag")
- unit: string or null (e.g. "sheets", "packs", "metres")
- supplierName: string or null
- deliveryTiming: string or null
- locationOrUse: string or null (where material was used or delivered to)
- confidenceLabel: "high" | "medium" | "low"
- confidenceReason: short explanation of why this confidence level was chosen
- uncertaintyFlags: array of strings, e.g. ["approximate_quantity", "supplier_unconfirmed", "date_uncertain"]

Rules:
- Split mixed content into separate facts — one object per distinct item
- Use factType "unclear" for ambiguous statements where the fact type cannot be determined
- Use low confidence and add uncertaintyFlags for approximate language: "probably", "about", "I think", "maybe", "roughly"
- Do not infer quantities, suppliers, dates, or other details not stated in the transcript
- Return [] if the transcript contains no site-relevant job facts
- Return only a valid JSON array, no surrounding text or markdown`

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
