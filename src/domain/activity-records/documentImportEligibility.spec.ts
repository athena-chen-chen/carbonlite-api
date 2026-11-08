import {
  isPreparedDocumentImportEligible,
  type PreparedDocumentImportEvidence,
} from './documentImportEligibility';

type EligibilityCase = [
  matchingStatus: string | null | undefined,
  calculationStatus: string | null | undefined,
  reportTreatment: string | null | undefined,
  eligible: boolean,
];

describe('prepared document import eligibility (current policy)', () => {
  const emissionsCases: EligibilityCase[] = [
    ['MATCHED', 'CALCULATED', 'INCLUDED', true],
    ['MATCHED', 'CALCULATED', 'EXCLUDED', false],
    ['MATCHED', 'NEEDS_REVIEW', 'INCLUDED', false],
    ['MISSING_FACTOR', 'CALCULATED', 'INCLUDED', false],
    ['READY', 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', 'READY', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', 'READY', false],
    ['TRACKED_ONLY', 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', 'UNIT_MISMATCH', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', 'REQUIRES_REVIEW', false],
    [undefined, 'CALCULATED', 'INCLUDED', false],
    [null, 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', undefined, 'INCLUDED', false],
    ['MATCHED', null, 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', undefined, false],
    ['MATCHED', 'CALCULATED', null, false],
    [undefined, undefined, undefined, false],
    [null, null, null, false],
    ['matched', 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', 'calculated', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', 'included', false],
    [' MATCHED ', 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', ' CALCULATED ', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', ' INCLUDED ', false],
    ['UNKNOWN', 'CALCULATED', 'INCLUDED', false],
    ['MATCHED', 'UNKNOWN', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', 'UNKNOWN', false],
  ];

  it.each(emissionsCases)(
    'emissions: %p + %p + %p => %p',
    (matchingStatus, calculationStatus, reportTreatment, eligible) => {
      expect(isPreparedDocumentImportEligible({
        matchingStatus, calculationStatus, reportTreatment,
      })).toBe(eligible);
    },
  );

  // matchingStatus is intentionally irrelevant to the current tracked branch,
  // including missing, contradictory, lowercase, and unknown matching values.
  const trackedCases: EligibilityCase[] = [
    ['TRACKED_ONLY', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['MATCHED', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['MISSING_FACTOR', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['UNIT_MISMATCH', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['NEEDS_REVIEW', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['EXCLUDED', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    [undefined, 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    [null, 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['matched', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['UNKNOWN', 'TRACKED_ONLY', 'TRACKED_ONLY', true],
    ['TRACKED_ONLY', 'TRACKED_ONLY', 'INCLUDED', false],
    ['MATCHED', 'CALCULATED', 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', 'NEEDS_REVIEW', 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', 'TRACKED_ONLY', 'EXCLUDED', false],
    ['TRACKED_ONLY', undefined, 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', null, 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', 'TRACKED_ONLY', undefined, false],
    ['TRACKED_ONLY', 'TRACKED_ONLY', null, false],
    ['TRACKED_ONLY', 'tracked_only', 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', 'TRACKED_ONLY', 'tracked_only', false],
    ['TRACKED_ONLY', ' TRACKED_ONLY ', 'TRACKED_ONLY', false],
    ['TRACKED_ONLY', 'TRACKED_ONLY', ' TRACKED_ONLY ', false],
    ['TRACKED_METRIC', 'TRACKED_METRIC', 'TRACKED_METRIC', false],
    ['TRACKED_ONLY', 'tracked only', 'tracked-only', false],
    ['TRACKED_ONLY', 'Water usage is tracked only', 'excluded from emissions totals', false],
  ];

  it.each(trackedCases)(
    'tracked: %p + %p + %p => %p',
    (matchingStatus, calculationStatus, reportTreatment, eligible) => {
      expect(isPreparedDocumentImportEligible({
        matchingStatus, calculationStatus, reportTreatment,
      })).toBe(eligible);
    },
  );

  it('exhausts the status matrix against an explicit set of eligible tuples', () => {
    const statuses = [
      undefined, null, '', 'MATCHED', 'CALCULATED', 'INCLUDED', 'TRACKED_ONLY',
      'READY', 'NEEDS_REVIEW', 'REQUIRES_REVIEW', 'MISSING_FACTOR', 'UNIT_MISMATCH',
      'EXCLUDED', 'TRACKED_METRIC', 'matched', 'calculated', 'included',
      'tracked_only', ' TRACKED_ONLY ', 'UNKNOWN', 'tracked only',
    ];
    const key = (row: PreparedDocumentImportEvidence) => JSON.stringify([
      row.matchingStatus, row.calculationStatus, row.reportTreatment,
    ]);
    const eligibleTuples = new Set([
      key({ matchingStatus: 'MATCHED', calculationStatus: 'CALCULATED', reportTreatment: 'INCLUDED' }),
      ...statuses.map(matchingStatus => key({
        matchingStatus, calculationStatus: 'TRACKED_ONLY', reportTreatment: 'TRACKED_ONLY',
      })),
    ]);

    for (const matchingStatus of statuses) {
      for (const calculationStatus of statuses) {
        for (const reportTreatment of statuses) {
          const row = { matchingStatus, calculationStatus, reportTreatment };
          expect({ row, eligible: isPreparedDocumentImportEligible(row) }).toEqual({
            row, eligible: eligibleTuples.has(key(row)),
          });
        }
      }
    }
  });
});
