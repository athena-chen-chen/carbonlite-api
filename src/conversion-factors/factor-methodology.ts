/** Scientific applicability and dimensional checks kept separate from the
 * frozen P0 workspace/security predicate. This does not certify arbitrary
 * factor sources; it only rejects known-inapplicable or dimensionally unsafe
 * methods before ranking.
 */
export type InventoryMethodMetadata = {
  id?: string | null;
  unit?: string | null;
  inputUnit?: string | null;
  resultUnit?: string | null;
  factorVersion?: string | null;
  factorSet?: string | null;
  sourceVersion?: string | null;
  methodologyProvenance?: unknown;
  source?: unknown;
};

/** Existing catalogs represented these references as corporate inventory
 * methods even though their published boundaries do not establish that use.
 * Keep them available as historical/source evidence, but fail closed for new
 * automatic calculations until a separately reviewed method is registered.
 */
export function isMethodologySupportedForInventory(
  factor: InventoryMethodMetadata,
): boolean {
  if (
    factor.id === 'eccc-natural-gas-canada-generic-gj-2025' ||
    /^eccc-electricity-(?:ab|bc|on)-(?:2025|2026)$/.test(factor.id ?? '')
  ) {
    return false;
  }

  const provenance = factor.methodologyProvenance;
  const provenanceVersion =
    provenance && typeof provenance === 'object' && !Array.isArray(provenance)
      ? (provenance as { sourceVersion?: unknown }).sourceVersion
      : undefined;
  const sourceVersions = [
    provenanceVersion,
    factor.factorVersion,
    factor.factorSet,
    factor.sourceVersion,
    sourceVersion(factor.source),
  ];
  if (
    sourceVersions.some((value) =>
      [
        'ECCC_EPR_2025_TABLE_A8',
        'ECCC_REFERENCE_2025',
        'ECCC_REFERENCE_2026',
      ].includes(String(value ?? '')),
    )
  ) {
    return false;
  }

  // Current inventory evaluators emit kgCO2e directly. They have no result-
  // mass conversion step, so reject g/t/component results rather than silently
  // relabelling them. Missing legacy units retain existing P0 compatibility;
  // that compatibility is not a claim of source approval.
  if (!factor.resultUnit) return true;
  const parts = factor.resultUnit.split('/');
  if (
    parts.length > 2 ||
    !/^kgco2(?:e|eq|equivalent)$/.test(unitKey(parts[0]))
  ) {
    return false;
  }
  if (parts.length === 2) {
    const denominator = unitKey(parts[1]);
    const inputUnit = factor.inputUnit || factor.unit;
    if (!denominator || (inputUnit && denominator !== unitKey(inputUnit))) {
      return false;
    }
  }
  return true;
}

function sourceVersion(source: unknown): unknown {
  return source && typeof source === 'object' && !Array.isArray(source)
    ? (source as { sourceVersion?: unknown }).sourceVersion
    : undefined;
}

function unitKey(value: string): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/₂/g, '2')
    .replace(/³/g, '3')
    .replace(/[\s_-]/g, '');
  const aliases: Record<string, string> = {
    liter: 'l',
    liters: 'l',
    litre: 'l',
    litres: 'l',
    night: 'nights',
    cubicmeter: 'm3',
    cubicmeters: 'm3',
    cubicmetre: 'm3',
    cubicmetres: 'm3',
    kilometer: 'km',
    kilometers: 'km',
    kilometre: 'km',
    kilometres: 'km',
    tonkm: 'tonnekm',
    tonneskm: 'tonnekm',
  };
  return aliases[key] ?? key;
}
