// Pilot domain vocabulary injected into the OpenAI extraction prompt.
// This is context for the model — not a database, not injected facts.
// The deterministic correction guard (Ticket 1d) remains the safety net.

export const PILOT_DOMAIN_CONTEXT = `
## Pilot Domain Vocabulary

The following suppliers and materials are common in UK residential building work.
Use this as domain context to interpret likely speech-to-text transcription errors
in voice notes. Do not inject these names unless the transcript clearly refers to them.

### Known pilot suppliers

Jewson, Travis Perkins, Screwfix, Toolstation, Selco

### Known pilot materials and trade terms

OSB, plasterboard, insulation, Celotex, battens, cladding, screws

### Likely speech-to-text variants

Supplier variants — only correct when strong order or delivery context is present:
- "Duesen's", "juice and", "jewels and" may indicate Jewson
- "traffic Perkins", "Travis parking" may indicate Travis Perkins
- "screw fix" usually means Screwfix; "screw fits" may indicate Screwfix in strong context
- "tool station" usually means Toolstation; "two station" may indicate Toolstation in strong context

Material variants — only correct when the described physical context supports it:
- "USB" or "OSP" near boards, sheets, walls, floors, or roofs may indicate OSB
- "sellotex" or "cell attack" near insulation, packs, or panels may indicate Celotex
- "plastic board" or "plaster bored" near sheets, walls, ceilings, or Jewson may indicate plasterboard
- "buttons" in a frame, framing, or timber context may indicate battens
- "clouding" in an elevation, external, or trims context may indicate cladding

### Uncertainty rules for corrected mishears

If you correct a likely speech-to-text variant to a known pilot term:
- Set confidenceLabel to "medium" unless the clean canonical form appears explicitly in the transcript
- Add "supplier_uncertain" to uncertaintyFlags when correcting a supplier name
- Add "material_uncertain" to uncertaintyFlags when correcting a material name

### Weak-context guardrail

Do not force a supplier or material name from the glossary when context is weak.
If you cannot confidently distinguish a mishear from a real token, leave supplierName
or materialName null, or use factType "unclear" rather than inventing a known glossary term.

### Person-name trap

"Jason" is a common UK person name. Do NOT correct "Jason" to "Jewson".
Do not turn person names, customer names, or neighbour names into supplier names.`.trimStart()
