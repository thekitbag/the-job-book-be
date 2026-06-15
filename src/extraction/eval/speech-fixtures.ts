import type { ExtractionFixture, ExpectedFact } from './fixtures.js'

export type CredibilityRisk = 'high' | 'medium' | 'low'

export interface SpeechFixture extends ExtractionFixture {
  intendedUtterance: string
  domainTerms: string[]
  credibilityRisk: CredibilityRisk
}

const GARDEN_ROOM = { title: 'Garden room build', jobType: 'garden_room' }

// Explicit empty string in supplierName/materialName means "this field must be absent/empty".
// The comparison treats '' the same as undefined (both normalise to ''), so a provider
// correctly omitting the field will match. A provider setting a non-empty value is a mismatch.

export const SPEECH_FIXTURES: SpeechFixture[] = [

  // ── Supplier: clean ────────────────────────────────────────────────────────

  {
    id: 'sup-jewson-clean',
    title: 'Jewson — clean utterance',
    intendedUtterance: 'Ordered twelve sheets of plasterboard from Jewson, delivery tomorrow morning.',
    transcriptText: 'Ordered twelve sheets of plasterboard from Jewson, delivery tomorrow morning.',
    domainTerms: ['Jewson', 'plasterboard'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'clean', 'ordered_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: 'Jewson',
        deliveryTiming: 'tomorrow morning',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — Jewson and plasterboard should be captured correctly with high confidence.',
  },

  {
    id: 'sup-travis-clean',
    title: 'Travis Perkins — clean utterance with C24 timber',
    intendedUtterance: 'Picked up fifty C24 timber lengths from Travis Perkins this morning.',
    transcriptText: 'Picked up fifty C24 timber lengths from Travis Perkins this morning.',
    domainTerms: ['Travis Perkins', 'C24 timber'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'clean', 'ordered_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'C24 timber',
        quantity: '50',
        unit: 'lengths',
        supplierName: 'Travis Perkins',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — Travis Perkins and C24 timber should be captured correctly with high confidence.',
  },

  {
    id: 'sup-screwfix-clean',
    title: 'Screwfix — clean utterance',
    intendedUtterance: 'Ordered a box of fifty screws from Screwfix for collection tomorrow.',
    transcriptText: 'Ordered a box of fifty screws from Screwfix for collection tomorrow.',
    domainTerms: ['Screwfix'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'clean', 'ordered_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'screws',
        quantity: '50',
        unit: 'box',
        supplierName: 'Screwfix',
        deliveryTiming: 'collection tomorrow',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — Screwfix should be captured correctly with high confidence.',
  },

  {
    id: 'sup-toolstation-clean',
    title: 'Toolstation — clean utterance',
    intendedUtterance: 'Got a quote from Toolstation on the window fixings.',
    transcriptText: 'Got a quote from Toolstation on the window fixings.',
    domainTerms: ['Toolstation'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'clean', 'supplier_delivery_note'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'supplier_delivery_note',
        supplierName: 'Toolstation',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — Toolstation should be captured correctly with high confidence.',
  },

  // ── Supplier: mishear ──────────────────────────────────────────────────────

  {
    id: 'sup-jewson-juice-and',
    title: 'Jewson misheard as "juice and"',
    intendedUtterance: 'Ordered twelve sheets of plasterboard from Jewson, delivery tomorrow morning.',
    transcriptText: 'Ordered twelve sheets of plasterboard from juice and, delivery tomorrow morning.',
    domainTerms: ['Jewson'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'mishear', 'ordered_material'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'plasterboard',
        quantity: '12',
        unit: 'sheets',
        supplierName: '',       // must not store "juice and" as a supplier
        deliveryTiming: 'tomorrow morning',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: 'Do not store "juice and" as a confident supplier name. Supplier should be omitted or flagged uncertain.',
  },

  {
    id: 'sup-jewson-jason',
    title: 'Jewson misheard as "Jason" (sounds like a person name)',
    intendedUtterance: 'Ordered six bags of cement from Jewson, delivery Friday.',
    transcriptText: 'Ordered six bags of cement from Jason, delivery Friday.',
    domainTerms: ['Jewson'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'mishear', 'person_name', 'ordered_material'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'cement',
        quantity: '6',
        unit: 'bags',
        supplierName: '',      // Jason looks like a person name — must not become a confident supplier
        deliveryTiming: 'Friday',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"Jason" sounds like a person name. Must not become a confident supplier. Jewson cannot safely be assumed from Jason alone.',
  },

  {
    id: 'sup-travis-traffic-perkins',
    title: 'Travis Perkins misheard as "traffic Perkins"',
    intendedUtterance: 'Picked up battens from Travis Perkins yesterday.',
    transcriptText: 'Picked up battens from traffic Perkins yesterday.',
    domainTerms: ['Travis Perkins', 'battens'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'mishear', 'ordered_material'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'battens',
        supplierName: '',      // "traffic Perkins" is not a real supplier
        confidenceLabel: 'medium',
        uncertaintyFlags: ['supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"traffic Perkins" is not a real supplier. The surname hint alone is insufficient to safely correct to Travis Perkins.',
  },

  {
    id: 'sup-screwfix-spacing',
    title: 'Screwfix spaced as "screw fix" — acceptable spacing variant',
    intendedUtterance: 'Ordered joist hangers from Screwfix.',
    transcriptText: 'Ordered joist hangers from screw fix.',
    domainTerms: ['Screwfix'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'spacing_variant', 'ordered_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'joist hangers',
        supplierName: 'Screwfix',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: '"screw fix" is a recognisable spacing variant of Screwfix. Normalisation with high confidence is acceptable when context (construction) supports it.',
  },

  {
    id: 'sup-toolstation-two-station',
    title: 'Toolstation misheard as "two station"',
    intendedUtterance: 'The Toolstation order came in but we are missing four lengths.',
    transcriptText: 'The two station order came in but we are missing four lengths.',
    domainTerms: ['Toolstation'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'mishear', 'watch_out'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'watch_out',
        supplierName: '',      // "two station" must not become a confident supplier
        confidenceLabel: 'low',
        uncertaintyFlags: ['supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"two station" is garbled. The delivery issue is a watch_out but supplier identification is too uncertain to store.',
  },

  // ── Material: clean ────────────────────────────────────────────────────────

  {
    id: 'mat-osb-clean',
    title: 'OSB — clean utterance',
    intendedUtterance: 'Used six OSB boards on the back wall.',
    transcriptText: 'Used six OSB boards on the back wall.',
    domainTerms: ['OSB'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'clean', 'used_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'used_material',
        materialName: 'OSB',
        quantity: '6',
        unit: 'boards',
        locationOrUse: 'back wall',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — OSB should be captured correctly with high confidence.',
  },

  {
    id: 'mat-celotex-clean',
    title: 'Celotex — clean utterance',
    intendedUtterance: 'Put in three Celotex insulation panels under the floor.',
    transcriptText: 'Put in three Celotex insulation panels under the floor.',
    domainTerms: ['Celotex'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'clean', 'used_material'],
    credibilityRisk: 'low',
    expected: [
      {
        factType: 'used_material',
        materialName: 'Celotex',
        quantity: '3',
        unit: 'panels',
        locationOrUse: 'under the floor',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ] as ExpectedFact[],
    notes: 'Clean utterance — Celotex should be captured correctly with high confidence.',
  },

  // ── Material: mishear ──────────────────────────────────────────────────────

  {
    id: 'mat-osb-usb',
    title: 'OSB misheard as "USB"',
    intendedUtterance: 'Used six OSB boards on the back wall.',
    transcriptText: 'Used six USB boards on the back wall.',
    domainTerms: ['OSB'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'mishear', 'unclear'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"USB boards" has no construction meaning. Should not store "USB" as a confident material name — classify as unclear.',
  },

  {
    id: 'mat-celotex-sellotex',
    title: 'Celotex misheard as "sellotex"',
    intendedUtterance: 'Need three Celotex insulation packs, maybe four.',
    transcriptText: 'Need three sellotex insulation packs, maybe four.',
    domainTerms: ['Celotex'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'mishear', 'ordered_material'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'ordered_material',
        materialName: '',      // "sellotex" must not become a confident material name
        quantity: '3',
        unit: 'packs',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"sellotex" sounds like sellotape. Should not be stored as a confident material name.',
  },

  {
    id: 'mat-plasterboard-plastic-board',
    title: 'Plasterboard misheard as "plastic board"',
    intendedUtterance: 'Ordered twelve sheets of plasterboard from Jewson.',
    transcriptText: 'Ordered twelve sheets of plastic board from Jewson.',
    domainTerms: ['plasterboard'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'mishear', 'ordered_material'],
    credibilityRisk: 'medium',
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'plasterboard', // correction justified by context (Jewson + sheets)
        quantity: '12',
        unit: 'sheets',
        supplierName: 'Jewson',
        confidenceLabel: 'medium',    // hedged — context-dependent correction
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: 'Context (Jewson, sheets) strongly hints plasterboard. Correction at medium confidence is acceptable. High-confidence storage of "plastic board" as literal is a failure.',
  },

  {
    id: 'mat-battens-buttons',
    title: 'Battens misheard as "buttons"',
    intendedUtterance: 'Secured all the battens along the top of the frame.',
    transcriptText: 'Secured all the buttons along the top of the frame.',
    domainTerms: ['battens'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'mishear', 'unclear'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"buttons" has no construction meaning. Should not store "buttons" as a confident material name.',
  },

  {
    id: 'mat-cladding-clouding',
    title: 'Cladding misheard as "clouding"',
    intendedUtterance: 'Started the cladding on the south elevation.',
    transcriptText: 'Started the clouding on the south elevation.',
    domainTerms: ['cladding'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'mishear', 'unclear'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"clouding" has no construction meaning. Should not store "clouding" as a confident material or activity.',
  },

  {
    id: 'mat-breather-membrane-near-miss',
    title: 'Breather membrane — "breathing membrane" near-miss',
    intendedUtterance: 'Rolled out the breather membrane across the full roof before the tiles go on.',
    transcriptText: 'Rolled out the breathing membrane across the full roof before the tiles go on.',
    domainTerms: ['breather membrane'],
    jobContext: GARDEN_ROOM,
    tags: ['material', 'spacing_variant', 'used_material'],
    credibilityRisk: 'medium',
    expected: [
      {
        factType: 'used_material',
        materialName: 'breather membrane', // context (roof, tiles) supports recovery
        locationOrUse: 'full roof',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['material_uncertain'],
      },
    ] as ExpectedFact[],
    notes: '"breathing membrane" is one word off. Context (roof, tiles) supports recovery to "breather membrane" at medium confidence.',
  },

  // ── Bad token / mixed ──────────────────────────────────────────────────────

  {
    id: 'bad-both-mishears',
    title: 'Both material and supplier garbled ("plastic bored from Jason")',
    intendedUtterance: 'Ordered twelve sheets of plasterboard from Jewson.',
    transcriptText: 'Ordered twelve sheets of plastic bored from Jason.',
    domainTerms: ['plasterboard', 'Jewson'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'material', 'mishear', 'bad_token', 'unclear'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain', 'supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: 'Both material ("plastic bored") and supplier ("Jason") are garbled. Should classify as unclear — not store confident nonsense.',
  },

  {
    id: 'mixed-triple-mishear',
    title: 'OSB + Celotex + Jewson all garbled simultaneously',
    intendedUtterance: 'Used OSB boards and Celotex on the back wall, picked up from Jewson yesterday.',
    transcriptText: 'Used USB boards and sellotex on the back wall, picked up from juice and yesterday.',
    domainTerms: ['OSB', 'Celotex', 'Jewson'],
    jobContext: GARDEN_ROOM,
    tags: ['supplier', 'material', 'mishear', 'mixed', 'bad_token'],
    credibilityRisk: 'high',
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
        uncertaintyFlags: ['material_uncertain', 'supplier_uncertain'],
      },
    ] as ExpectedFact[],
    notes: 'All three domain terms garbled simultaneously. Should produce low-confidence unclear output, not multiple confident nonsense facts.',
  },

  {
    id: 'real-customer-name-dave',
    title: 'Customer name "Dave" must not become a supplier',
    intendedUtterance: 'Had a chat with Dave about the boundary fence. He is fine with the extension coming up to his fence.',
    transcriptText: 'Had a chat with Dave about the boundary fence. He is fine with the extension coming up to his fence.',
    domainTerms: ['Dave'],
    jobContext: GARDEN_ROOM,
    tags: ['person_name', 'mixed'],
    credibilityRisk: 'high',
    expected: [],
    notes: '"Dave" is a customer/neighbour. No ordered_material or supplier_delivery_note facts expected. Dave must not appear as a confident supplier name.',
  },
]
