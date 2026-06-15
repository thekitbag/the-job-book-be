import type { FactType, ConfidenceLabel } from '../types.js'

export interface ExpectedFact {
  factType: FactType
  materialName?: string
  quantity?: string
  unit?: string
  supplierName?: string
  deliveryTiming?: string
  locationOrUse?: string
  confidenceLabel?: ConfidenceLabel
  uncertaintyFlags?: string[]
}

export interface ExtractionFixture {
  id: string
  title: string
  transcriptText: string
  jobContext: { title: string; jobType: string }
  tags: string[]
  expected: ExpectedFact[]
  notes: string
}

export const GOLDEN_FIXTURES: ExtractionFixture[] = [
  // ── Ordered Materials ─────────────────────────────────────────────────────

  {
    id: 'ordered-001',
    title: 'Plasterboard from Jewson — explicit quantity and delivery',
    transcriptText: 'Ordered twelve sheets of 12.5 mil plasterboard from Jewson, coming tomorrow morning.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['ordered_material'],
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
    ],
    notes: 'Number word "twelve" should normalise to 12. Supplier and delivery timing are explicit — confidence should be high.',
  },

  {
    id: 'ordered-002',
    title: 'C24 timber from Travis Perkins — length order for roof',
    transcriptText: 'Get eight lengths of C24 timber from Travis Perkins for the roof.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['ordered_material'],
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'C24 timber',
        quantity: '8',
        unit: 'lengths',
        supplierName: 'Travis Perkins',
        locationOrUse: 'roof',
        confidenceLabel: 'high',
      },
    ],
    notes: '"Eight" should normalise. "For the roof" is locationOrUse, not deliveryTiming.',
  },

  {
    id: 'ordered-003',
    title: 'Screws — uncertain quantity (one box or two)',
    transcriptText: "I ordered more screws, not sure if it's one box or two.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['ordered_material', 'approximate'],
    expected: [
      {
        factType: 'ordered_material',
        materialName: 'screws',
        confidenceLabel: 'low',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: 'Quantity is explicitly uncertain. Should mark low confidence and approximate_quantity flag. No supplier stated — must not invent one.',
  },

  // ── Used Materials ────────────────────────────────────────────────────────

  {
    id: 'used-001',
    title: 'OSB boards — precise use on back wall',
    transcriptText: 'Used six OSB boards on the back wall today.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['used_material'],
    expected: [
      {
        factType: 'used_material',
        materialName: 'OSB boards',
        quantity: '6',
        unit: 'boards',
        locationOrUse: 'back wall',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Clean explicit use statement. Quantity, material, and location all stated clearly.',
  },

  {
    id: 'used-002',
    title: 'Breather membrane — imprecise "one and a bit"',
    transcriptText: 'Put one and a bit rolls of breather membrane round the side elevation.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['used_material', 'approximate'],
    expected: [
      {
        factType: 'used_material',
        materialName: 'breather membrane',
        quantity: 'one and a bit',
        unit: 'rolls',
        locationOrUse: 'side elevation',
        confidenceLabel: 'medium',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: '"One and a bit" should be preserved verbatim, not rounded to 1. Approximate quantity flag required.',
  },

  {
    id: 'used-003',
    title: '5x2 timber for floor — "most of" with uncertain count',
    transcriptText: 'We used most of the 5x2 timber for the floor, maybe eight lengths.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['used_material', 'approximate'],
    expected: [
      {
        factType: 'used_material',
        materialName: '5x2 timber',
        locationOrUse: 'floor',
        confidenceLabel: 'low',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: '"Most of" and "maybe" both indicate uncertainty. Should not resolve to a precise 8.',
  },

  // ── Leftovers ─────────────────────────────────────────────────────────────

  {
    id: 'leftover-001',
    title: 'Weed membrane — measured remainder after finishing',
    transcriptText: 'There are two metres of weed membrane left over after finishing the base.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'weed membrane',
        quantity: '2',
        unit: 'metres',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Precise stated remainder. No uncertainty language. High confidence expected.',
  },

  {
    id: 'leftover-002',
    title: 'Cement — "probably half a bag" by mixer',
    transcriptText: 'Probably half a bag of cement left by the mixer.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'approximate'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'cement',
        quantity: 'half a bag',
        unit: 'bags',
        confidenceLabel: 'low',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: '"Probably" is a clear uncertainty marker. "Half a bag" should be preserved not converted to 0.5.',
  },

  {
    id: 'leftover-003',
    title: 'Insulation — "I think" three packs spare',
    transcriptText: 'I think we have three packs of insulation spare.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'approximate'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'insulation',
        quantity: '3',
        unit: 'packs',
        confidenceLabel: 'low',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: '"I think" introduces uncertainty. Three packs is the stated quantity but marked low confidence.',
  },

  // ── Supplier / Delivery Notes ─────────────────────────────────────────────

  {
    id: 'supplier-001',
    title: 'Jewson plasterboard delayed to Friday',
    transcriptText: "Jewson said the plasterboard won't arrive until Friday now.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['supplier_delivery_note'],
    expected: [
      {
        factType: 'supplier_delivery_note',
        supplierName: 'Jewson',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Delivery delay from named supplier. Must classify as supplier_delivery_note, not ordered_material.',
  },

  {
    id: 'supplier-002',
    title: 'Travis Perkins hardcore dropped at wrong location',
    transcriptText: 'Travis Perkins dropped the hardcore at the front gate, not by the garage.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['supplier_delivery_note'],
    expected: [
      {
        factType: 'supplier_delivery_note',
        materialName: 'hardcore',
        supplierName: 'Travis Perkins',
        locationOrUse: 'front gate',
        confidenceLabel: 'high',
      },
    ],
    notes: 'Delivery location problem. Should stay as supplier_delivery_note, not used_material.',
  },

  {
    id: 'supplier-003',
    title: 'Cladding delivery missing trims — no supplier named',
    transcriptText: 'The cladding delivery is missing the trims.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['supplier_delivery_note'],
    expected: [
      {
        factType: 'supplier_delivery_note',
        materialName: 'cladding trims',
        confidenceLabel: 'high',
      },
    ],
    notes: 'No supplier named — must not invent one. Delivery issue should be a supplier_delivery_note.',
  },

  // ── Customer Changes ──────────────────────────────────────────────────────

  {
    id: 'customer-001',
    title: 'Window position moved by customer',
    transcriptText: 'Sarah wants the window moved six inches to the left.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['customer_change'],
    expected: [
      {
        factType: 'customer_change',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Direct customer instruction. Named person ("Sarah"). High confidence, no uncertainty.',
  },

  {
    id: 'customer-002',
    title: 'Guttering colour changed by customer',
    transcriptText: 'Customer asked for black guttering instead of white.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['customer_change'],
    expected: [
      {
        factType: 'customer_change',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Explicit change request. Should not be classified as ordered_material.',
  },

  {
    id: 'customer-003',
    title: 'Extra socket — unconfirmed customer request',
    transcriptText: "They might want an extra socket by the desk, not confirmed yet.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['customer_change', 'approximate'],
    expected: [
      {
        factType: 'customer_change',
        confidenceLabel: 'low',
        uncertaintyFlags: ['unconfirmed'],
      },
    ],
    notes: '"Might want" and "not confirmed yet" are explicit uncertainty markers. Low confidence and unconfirmed flag expected.',
  },

  // ── Watch-Outs ────────────────────────────────────────────────────────────

  {
    id: 'watchout-001',
    title: 'Soft corner after rain — safety risk',
    transcriptText: 'Watch out, the back left corner is still soft after the rain.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['watch_out'],
    expected: [
      {
        factType: 'watch_out',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Explicit "watch out" signal. Risk preserved in summary. High confidence.',
  },

  {
    id: 'watchout-002',
    title: 'Floor dip near doorway — structural note',
    transcriptText: 'Remember the floor dips near the doorway.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['watch_out'],
    expected: [
      {
        factType: 'watch_out',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: '"Remember" introduces a site risk note. Should classify as watch_out.',
  },

  {
    id: 'watchout-003',
    title: 'Hidden cable behind stud — do not drill',
    transcriptText: "Don't drill the right-hand stud, there's a cable behind it.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['watch_out'],
    expected: [
      {
        factType: 'watch_out',
        confidenceLabel: 'high',
        uncertaintyFlags: [],
      },
    ],
    notes: 'Safety instruction about hidden cable. Must be watch_out, not customer_change.',
  },

  // ── Unclear / Noisy ───────────────────────────────────────────────────────

  {
    id: 'unclear-001',
    title: 'Vague reference to something being wrong',
    transcriptText: 'That thing from yesterday is still wrong, sort it before Friday.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['unclear'],
    expected: [
      {
        factType: 'unclear',
        confidenceLabel: 'low',
      },
    ],
    notes: 'No material, supplier, or change identifiable. Should extract as unclear or return no facts — must not invent specifics.',
  },

  {
    id: 'unclear-002',
    title: 'Vague mention of conversation — no fact extractable',
    transcriptText: "Spoke to Dave about the bits, can't remember what he said.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['unclear'],
    expected: [],
    notes: 'No actionable information. Extraction should return empty or a single unclear with no invented detail.',
  },

  {
    id: 'unclear-003',
    title: 'Self-correction — no facts',
    transcriptText: 'Ignore that, I was talking to someone else.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['unclear'],
    expected: [],
    notes: 'Explicit retraction. Should return no facts. Any extraction is an invented fact.',
  },

  // ── Mixed Notes ───────────────────────────────────────────────────────────

  {
    id: 'mixed-001',
    title: 'Ply used + order from Jewson + socket change — three separate facts',
    transcriptText: 'Used four sheets of ply on the roof, ordered two more from Jewson, and Sarah wants the socket moved.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['used_material', 'ordered_material', 'customer_change', 'mixed'],
    expected: [
      {
        factType: 'used_material',
        materialName: 'ply',
        quantity: '4',
        unit: 'sheets',
        locationOrUse: 'roof',
      },
      {
        factType: 'ordered_material',
        materialName: 'ply',
        quantity: '2',
        supplierName: 'Jewson',
      },
      {
        factType: 'customer_change',
      },
    ],
    notes: 'Three distinct fact types in one note. Splitting is critical. Customer change must not be merged with material facts.',
  },

  {
    id: 'mixed-002',
    title: 'Screws in workshop + plasterboard still to order',
    transcriptText: 'There is half a box of screws in the workshop, but we still need to order more plasterboard.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'ordered_material', 'workshop', 'mixed'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'screws',
        quantity: 'half a box',
        locationOrUse: 'workshop',
      },
      {
        factType: 'ordered_material',
        materialName: 'plasterboard',
      },
    ],
    notes: 'Workshop location on leftover. Plasterboard still to order. Should split into two facts.',
  },

  // ── Contradictions ────────────────────────────────────────────────────────

  {
    id: 'contradiction-001',
    title: 'Correction — insulation pack count revised down',
    transcriptText: "I said earlier there were three packs left, actually there are only two.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'contradiction'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'insulation packs',
        quantity: '2',
        unit: 'packs',
        confidenceLabel: 'medium',
      },
    ],
    notes: 'Explicit self-correction. The final stated value (2) is the one to preserve. The draft fact should reflect the correction, not the original. May also be unclear — report must flag as contradiction case.',
  },

  {
    id: 'contradiction-002',
    title: 'Order cancelled — OSB found in workshop',
    transcriptText: "Cancel the order for the extra OSB; we found enough in the workshop.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'contradiction', 'workshop'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'OSB',
        locationOrUse: 'workshop',
      },
    ],
    notes: 'Order cancellation implicitly reveals workshop stock. The leftover is the actionable fact. Must not create an ordered_material fact for the cancelled order.',
  },

  // ── Workshop Mentions ─────────────────────────────────────────────────────

  {
    id: 'workshop-001',
    title: 'OSB sheets stored in workshop — stock note',
    transcriptText: "I've got three sheets of OSB in the workshop.",
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'workshop'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'OSB',
        quantity: '3',
        unit: 'sheets',
        locationOrUse: 'workshop',
        confidenceLabel: 'high',
      },
    ],
    notes: 'Workshop-stored stock maps to leftover_material with locationOrUse=workshop in current schema. Future workshop fact type would supersede this.',
  },

  {
    id: 'workshop-002',
    title: 'Screws in workshop — approximate stock',
    transcriptText: 'There should be half a box of screws back at the workshop.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'workshop', 'approximate'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'screws',
        quantity: 'half a box',
        locationOrUse: 'workshop',
        confidenceLabel: 'low',
        uncertaintyFlags: ['approximate_quantity'],
      },
    ],
    notes: '"Should be" is uncertainty language. Half a box is approximate. Workshop location should be preserved.',
  },

  {
    id: 'workshop-003',
    title: 'Use workshop cladding before ordering — implied stock',
    transcriptText: 'Use the spare cladding from the workshop before ordering more.',
    jobContext: { title: 'Garden room', jobType: 'garden_room' },
    tags: ['leftover_material', 'workshop'],
    expected: [
      {
        factType: 'leftover_material',
        materialName: 'cladding',
        locationOrUse: 'workshop',
      },
    ],
    notes: 'Instruction implies spare cladding exists in workshop. No quantity stated — must not invent one. Do not create an ordered_material fact for the implied future order.',
  },
]
