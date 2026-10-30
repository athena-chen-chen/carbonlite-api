/** In-memory legitimate-source metadata, not approval of the supplied numerical values.
 * Only tests import these models; no seed records or workspace authorization change.
 */
export const LEGITIMATE_OFFICIAL_FACTOR = {
  sourceAuthority: 'Example inventory agency',
  sourceDocument: 'Published inventory factors',
  sourceName: 'Example inventory agency',
  sourceReference: 'Published inventory factors',
  confidenceLevel: 'OFFICIAL_GOVERNMENT',
  verified: true,
  verificationStatus: 'VERIFIED',
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
} as const;

export const LEGITIMATE_ORGANIZATION_FACTOR = {
  sourceAuthority: 'Customer measurement laboratory',
  sourceDocument: 'Reviewed site inventory methodology',
  confidenceLevel: 'CUSTOM',
  verified: true,
  verificationStatus: 'VERIFIED',
  applicability: 'CORPORATE_INVENTORY',
  emissionBasis: 'DIRECT_CO2E',
} as const;
