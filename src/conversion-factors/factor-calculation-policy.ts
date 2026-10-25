/** Pure workspace policy, mirrored in the separately deployed API repository.
 * This excludes known non-customer data; it does not certify factor methodology.
 */
export type FactorWorkspacePolicy = {
  organizationId?: string | null;
  allowDemoFactorsForCalculations?: boolean | null;
};

export type FactorPolicyMetadata = {
  organizationId?: string | null;
  name?: string | null;
  displayName?: string | null;
  status?: string | null;
  factorStatus?: string | null;
  factorSet?: string | null;
  factorType?: string | null;
  confidence?: string | null;
  confidenceLevel?: string | null;
  verificationStatus?: string | null;
  isDemo?: boolean | null;
  isSynthetic?: boolean | null;
  isTestOnly?: boolean | null;
  isPilotEstimate?: boolean | null;
  isPlaceholder?: boolean | null;
  sourceAuthority?: string | null;
  sourceName?: string | null;
  sourceDocument?: string | null;
  sourceReference?: string | null;
  methodology?: string | null;
  methodologyProvenance?: unknown;
  notes?: string | null;
  source?: FactorPolicyMetadata | null;
  factor?: FactorPolicyMetadata | null;
};

const excludedLabels = new Set([
  'DEMO', 'SYNTHETIC', 'TEST_ONLY', 'FIXTURE', 'MANUAL_TEST', 'RC_TEST',
  'PILOT_ESTIMATE', 'GENERIC_ESTIMATE', 'PLACEHOLDER', 'PILOT_DEFAULT_V0_1',
]);
const label = (value?: string | null) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** Temporary compatibility for existing rows without structured test metadata.
 * Deliberately does not reject generic estimates, "test" in isolation, ownership,
 * DRAFT, or verified=false. These are not proof that a factor is test-only.
 */
export function hasLegacyTestFactorMarkers(factor: FactorPolicyMetadata): boolean {
  if ([factor.sourceAuthority, factor.sourceName].some(value => label(value) === 'CARBONLITE_SYSTEM_DEFAULTS')) return true;
  if ([factor.sourceDocument, factor.sourceReference].some(value =>
    /^CarbonLite (?:MVP Default Factors|Default Factor Library) v1\.0$/i.test(String(value ?? '').trim()))) return true;
  const text = [factor.name, factor.displayName, factor.sourceAuthority, factor.sourceName,
    factor.sourceDocument, factor.sourceReference, factor.methodology, factor.notes].filter(Boolean).join(' ');
  return /\b(?:synthetic|demo|fixtures?|manual[ _-]test|test[ _-](?:only|factor|fixture)|rc[ _-](?:(?:isolated[ _-])?(?:test|fixture|history|historical))|pilot[ _-](?:estimate|testing|validation)|demonstration workflows only)\b/i.test(text);
}

function isKnownTestFactor(factor: FactorPolicyMetadata): boolean {
  // Exact identity used by the existing demo seed, not a tenant-name heuristic.
  if (factor.organizationId === 'demo-org-id') return true;
  if (factor.isDemo || factor.isSynthetic || factor.isTestOnly || factor.isPilotEstimate || factor.isPlaceholder) return true;
  if ([factor.status, factor.factorStatus, factor.factorSet, factor.factorType, factor.confidence,
    factor.confidenceLevel, factor.verificationStatus].some(value => excludedLabels.has(label(value)) || /(?:^|_)(?:DEMO|SYNTHETIC|TEST_ONLY|FIXTURE|MANUAL_TEST|RC_TEST|PILOT_ESTIMATE|PILOT_DEFAULT|GENERIC_ESTIMATE|PLACEHOLDER)(?:_|$)/.test(label(value)))) return true;
  const provenance = factor.methodologyProvenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance) &&
    isKnownTestFactor({ ...(provenance as FactorPolicyMetadata), methodologyProvenance: undefined, source: undefined, factor: undefined })) return true;
  return hasLegacyTestFactorMarkers(factor);
}

export function isFactorAllowedForWorkspace(factor: FactorPolicyMetadata, policy: FactorWorkspacePolicy = {}): boolean {
  const metadata = [factor, factor.factor, factor.source].filter((value): value is FactorPolicyMetadata => Boolean(value));
  // Tenant isolation applies even to demo-enabled workspaces and system flags.
  if (metadata.some(value => value.organizationId && value.organizationId !== policy.organizationId)) return false;
  return policy.allowDemoFactorsForCalculations === true || !metadata.some(isKnownTestFactor);
}
