/** Server-prepared evidence only; this policy does not validate raw/client/model input. */
export type PreparedDocumentImportEvidence = {
  matchingStatus?: string | null;
  calculationStatus?: string | null;
  reportTreatment?: string | null;
};

export function isPreparedDocumentImportEligible(
  activity: PreparedDocumentImportEvidence,
): boolean {
  return (
    (activity.calculationStatus === 'TRACKED_ONLY' && activity.reportTreatment === 'TRACKED_ONLY') ||
    (activity.matchingStatus === 'MATCHED' &&
      activity.calculationStatus === 'CALCULATED' &&
      activity.reportTreatment === 'INCLUDED')
  );
}
