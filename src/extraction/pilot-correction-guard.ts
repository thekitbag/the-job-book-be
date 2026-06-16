import type { CandidateFactDraft, ConfidenceLabel } from './types.js'

export interface GuardInput {
  transcriptText: string
  jobContext: { title: string; jobType: string }
  facts: CandidateFactDraft[]
}

// ── Glossary ──────────────────────────────────────────────────────────────────

// Canonical names — any exact match (case-insensitive) gets its display case fixed.
const CANONICAL_SUPPLIERS = ['Jewson', 'Travis Perkins', 'Screwfix', 'Toolstation', 'Selco']
const CANONICAL_MATERIALS = ['OSB', 'plasterboard', 'insulation', 'Celotex', 'battens', 'cladding', 'screws']

// Safe aliases: harmless spacing/plural/casing variants — canonicalise display, keep confidence.
const SUPPLIER_SAFE_ALIASES: Array<[RegExp, string]> = [
  [/^jewsons?$/i, 'Jewson'],
  [/^screw\s+fix$/i, 'Screwfix'],
  [/^tool\s+station$/i, 'Toolstation'],
]

const MATERIAL_SAFE_ALIASES: Array<[RegExp, string]> = [
  [/^osb$/i, 'OSB'],
]

// Person names that must NOT be corrected to a known supplier.
const PERSON_NAME_TRAPS: RegExp[] = [/^jason$/i]

// Risky mishears: plausible-sounding but wrong — correct only in strong context,
// otherwise clear the field. All risky corrections lower confidence and add a flag.
const SUPPLIER_RISKY_MISHEARS: Array<[RegExp, string]> = [
  [/^duesen'?s?$/i, 'Jewson'],
  [/^juice\s+and$/i, 'Jewson'],
  [/^jewels\s+and$/i, 'Jewson'],
  [/^traffic\s+perkins$/i, 'Travis Perkins'],
  [/^travis\s+parking$/i, 'Travis Perkins'],
  [/^screw\s+fits$/i, 'Screwfix'],
  [/^two\s+station$/i, 'Toolstation'],
]

// Material risky mishears with an optional context guard (undefined = always correct).
const MATERIAL_RISKY_MISHEARS: Array<[RegExp, string, ((t: string) => boolean) | undefined]> = [
  [/^usb\s+boards?$/i, 'OSB', hasBoardContext],
  [/^osp\s+boards?$/i, 'OSB', hasBoardContext],
  [/^sellotex(\s+insulation)?$/i, 'Celotex', hasInsulationContext],
  [/^cell\s+attack(\s+insulation)?$/i, 'Celotex', hasInsulationContext],
  [/^plastic\s+board$/i, 'plasterboard', hasPlasterboardContext],
  [/^plaster\s+bored$/i, 'plasterboard', hasPlasterboardContext],
  [/^buttons$/i, 'battens', hasFramingContext],
  [/^clouding$/i, 'cladding', hasElevationContext],
]

// ── Context detection ─────────────────────────────────────────────────────────

const ORDER_WORDS = ['ordered', ' from ', 'picked up', 'delivery', 'came in', 'supplier', 'quote', 'collection', 'invoice']
const SUPPLIER_FACT_TYPES = new Set(['ordered_material', 'supplier_delivery_note', 'used_material', 'leftover_material', 'watch_out'])
const MATERIAL_TERMS = ['plasterboard', 'osb', 'celotex', 'battens', 'cladding', 'timber', 'insulation', 'boards', 'sheets', 'panels', 'screws']

function hasStrongSupplierContext(transcript: string, factType: string): boolean {
  const t = transcript.toLowerCase()
  return (
    ORDER_WORDS.some((w) => t.includes(w)) ||
    SUPPLIER_FACT_TYPES.has(factType) ||
    MATERIAL_TERMS.some((m) => t.includes(m))
  )
}

function hasBoardContext(transcript: string): boolean {
  const t = transcript.toLowerCase()
  return ['board', 'sheet', 'wall', 'floor', 'roof', 'timber'].some((w) => t.includes(w))
}

function hasInsulationContext(transcript: string): boolean {
  const t = transcript.toLowerCase()
  return ['insulation', 'pack', 'panel', 'install'].some((w) => t.includes(w))
}

function hasPlasterboardContext(transcript: string): boolean {
  const t = transcript.toLowerCase()
  return ['sheet', 'jewson', 'plaster', 'wall', 'ceiling', 'board'].some((w) => t.includes(w))
}

function hasFramingContext(transcript: string): boolean {
  const t = transcript.toLowerCase()
  return ['frame', 'framing', 'top', 'bottom', 'rail', 'timber'].some((w) => t.includes(w))
}

function hasElevationContext(transcript: string): boolean {
  const t = transcript.toLowerCase()
  return ['elevation', 'trim', 'external', 'gable', 'south', 'north', 'east', 'west', 'facade'].some((w) =>
    t.includes(w),
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lowerConfidence(c: ConfidenceLabel): ConfidenceLabel {
  return c === 'high' ? 'medium' : c
}

function addFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Field guards ──────────────────────────────────────────────────────────────

function guardSupplierField(fact: CandidateFactDraft, transcript: string): CandidateFactDraft {
  const raw = fact.supplierName
  if (!raw) return fact

  // 1. Already a canonical name → fix casing only, keep confidence.
  for (const canonical of CANONICAL_SUPPLIERS) {
    if (raw.toLowerCase() === canonical.toLowerCase()) {
      return { ...fact, supplierName: canonical }
    }
  }

  // 2. Safe alias (harmless spacing/plural variant) → canonical display, keep confidence.
  for (const [pattern, canonical] of SUPPLIER_SAFE_ALIASES) {
    if (pattern.test(raw)) {
      return { ...fact, supplierName: canonical }
    }
  }

  // 3. Person-name trap → clear supplier, do not correct to any canonical name.
  for (const trap of PERSON_NAME_TRAPS) {
    if (trap.test(raw)) {
      return {
        ...fact,
        supplierName: undefined,
        confidenceLabel: lowerConfidence(fact.confidenceLabel),
        uncertaintyFlags: addFlag(fact.uncertaintyFlags, 'supplier_uncertain'),
        confidenceReason: 'Supplier name looks like a person name — not corrected to a known supplier',
      }
    }
  }

  // 4. Risky mishear → correct to canonical (strong context) or clear (weak context).
  for (const [pattern, canonical] of SUPPLIER_RISKY_MISHEARS) {
    if (pattern.test(raw)) {
      if (hasStrongSupplierContext(transcript, fact.factType)) {
        return {
          ...fact,
          supplierName: canonical,
          confidenceLabel: lowerConfidence(fact.confidenceLabel),
          uncertaintyFlags: addFlag(fact.uncertaintyFlags, 'supplier_uncertain'),
          confidenceReason: `Likely mishear of ${canonical} — corrected with uncertainty`,
        }
      } else {
        return {
          ...fact,
          supplierName: undefined,
          confidenceLabel: lowerConfidence(fact.confidenceLabel),
          uncertaintyFlags: addFlag(fact.uncertaintyFlags, 'supplier_uncertain'),
          confidenceReason: 'Supplier token not recognisable in context — removed',
        }
      }
    }
  }

  // Unknown supplier not in glossary — leave unchanged.
  return fact
}

function guardMaterialField(fact: CandidateFactDraft, transcript: string): CandidateFactDraft {
  const raw = fact.materialName
  if (!raw) return fact

  // 1. Already a canonical material → fix casing only.
  for (const canonical of CANONICAL_MATERIALS) {
    if (raw.toLowerCase() === canonical.toLowerCase()) {
      return { ...fact, materialName: canonical }
    }
  }

  // 2. Safe alias → canonical display, keep confidence.
  for (const [pattern, canonical] of MATERIAL_SAFE_ALIASES) {
    if (pattern.test(raw)) {
      return { ...fact, materialName: canonical }
    }
  }

  // 3. Risky mishear → correct (if context strong enough) or clear.
  for (const [pattern, canonical, contextCheck] of MATERIAL_RISKY_MISHEARS) {
    if (pattern.test(raw)) {
      const hasContext = contextCheck ? contextCheck(transcript) : true
      if (hasContext) {
        return {
          ...fact,
          materialName: canonical,
          confidenceLabel: lowerConfidence(fact.confidenceLabel),
          uncertaintyFlags: addFlag(fact.uncertaintyFlags, 'material_uncertain'),
          confidenceReason: `Likely mishear of ${canonical} — corrected with uncertainty`,
        }
      } else {
        return {
          ...fact,
          materialName: undefined,
          confidenceLabel: lowerConfidence(fact.confidenceLabel),
          uncertaintyFlags: addFlag(fact.uncertaintyFlags, 'material_uncertain'),
          confidenceReason: 'Material token not recognisable in context — removed',
        }
      }
    }
  }

  // Unknown material not in glossary — leave unchanged.
  return fact
}

// ── Summary sanitisation ──────────────────────────────────────────────────────
// Replace corrected/cleared tokens in the summary so Mike's review view
// does not show nonsense tokens as if they were confident facts.

function sanitiseSummary(
  guarded: CandidateFactDraft,
  original: CandidateFactDraft,
): CandidateFactDraft {
  let { summary } = guarded
  if (!summary) return guarded

  const origSupplier = original.supplierName
  if (origSupplier && origSupplier !== guarded.supplierName) {
    const replacement = guarded.supplierName ?? 'supplier unclear'
    summary = summary.replace(new RegExp(escapeRegExp(origSupplier), 'gi'), replacement)
  }

  const origMaterial = original.materialName
  if (origMaterial && origMaterial !== guarded.materialName) {
    const replacement = guarded.materialName ?? 'material unclear'
    summary = summary.replace(new RegExp(escapeRegExp(origMaterial), 'gi'), replacement)
  }

  return { ...guarded, summary }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function applyPilotCorrectionGuard(input: GuardInput): CandidateFactDraft[] {
  return input.facts.map((fact) => {
    const original = fact
    let guarded = guardSupplierField(fact, input.transcriptText)
    guarded = guardMaterialField(guarded, input.transcriptText)
    guarded = sanitiseSummary(guarded, original)
    return guarded
  })
}
