// Historical projection uses persisted data only. Never dereference the live factor library.
export function scopeForActivity(activity: string) {
  if (activity === 'ELECTRICITY') return 'SCOPE_2';
  if (['NATURAL_GAS', 'GASOLINE', 'DIESEL', 'STEAM'].includes(activity)) return 'SCOPE_1';
  return activity === 'WATER' ? 'TRACKED_METRIC' : 'SCOPE_3';
}

export function persistedCalculationDetail(record: any, base: any): any | null {
  const status = String(record.calculationStatus ?? '').trim().toUpperCase();
  const treatment = String(record.reportTreatment ?? '').trim().toUpperCase();
  // Explicit current state always outranks older snapshots and metric evidence.
  if ((status && status !== 'CALCULATED') || (treatment && treatment !== 'INCLUDED')) return null;

  const snapshot = record.calculationSnapshot;
  if (snapshot?.contractVersion === 1 && snapshot.detail?.status === 'CALCULATED' &&
      (!(record.calculationVersion > 0) || snapshot.version === record.calculationVersion)) {
    return { ...base, ...snapshot.detail, activityDataId: record.id,
      costCad: base.costCad, costCurrency: base.costCurrency, notes: base.notes,
      manualSourceProvenance: null, calculationSnapshotVersion: snapshot.version,
      calculatedAt: snapshot.calculatedAt, calculationActorId: snapshot.actorUserId };
  }
  // Versioned records require their matching current snapshot; only unversioned
  // legacy records may use the compatibility projection below.
  if (record.calculationVersion > 0) return null;
  // Compatibility with already-persisted historical results. No calculation/backfill on reads.
  const metric = record.metricResults?.[0];
  const details = metric?.detailsJson;
  const metricStatus = String(details?.calculationStatus ?? details?.status ?? '').trim().toUpperCase();
  const metricValue = metric && (!metricStatus || metricStatus === 'CALCULATED') && details?.factorValue != null ? Number(metric.value) : null;
  const legacy = record.calculationStatus === 'CALCULATED' && record.matchedFactorValue != null && record.calculatedEmissionsKgCO2e != null;
  if (metricValue === null && !legacy) return null;
  const value = metricValue ?? Number(record.calculatedEmissionsKgCO2e);
  const factorValue = Number(metricValue !== null ? details.factorValue : record.matchedFactorValue);
  if (!Number.isFinite(value) || !Number.isFinite(factorValue)) return null;
  const factorUnit = metricValue !== null ? details.factorUnit : String(record.matchedFactorUnit || record.unit).split('/').pop();
  const authority = metricValue !== null ? details.sourceAuthority : record.matchedFactorSourceAuthority;
  const sourceDocument = metricValue !== null ? details.sourceDocument : record.matchedFactorSourceDocument;
  const year = metricValue !== null ? details.sourceYear : record.matchedFactorSourceYear;
  return { ...base, status: 'CALCULATED', calculationStatus: 'CALCULATED', explanationStatus: 'CALCULATED',
    reason: null, matchingStatus: 'MATCHED', matchedBy: 'PERSISTED_SNAPSHOT', matchingMethod: 'PERSISTED_SNAPSHOT',
    matchingMessage: 'Historical calculation retained from persisted evidence.',
    factorId: record.matchedFactorId ?? metric?.factorId ?? null,
    factorVersionId: details?.factorVersionId ?? null,
    factorName: record.matchedFactorName ?? 'Historical factor', factorValue,
    factorInputUnit: factorUnit, factorResultUnit: 'kgCO2e', factorYear: year ?? null, sourceYear: year ?? null,
    sourceAuthority: authority ?? null, sourceDocument: sourceDocument ?? null, sourceUrl: details?.sourceUrl ?? null,
    factorProvenance: details?.factorProvenance ?? { sourceAuthority: authority ?? null, sourceDocument: sourceDocument ?? null, sourceYear: year ?? null },
    factorType: 'Historical', factorConfidenceLevel: record.matchedFactorConfidenceLevel ?? null,
    factorVerificationStatus: record.matchedFactorVerificationStatus ?? null, factorVerified: details?.verified ?? false,
    factorSelectionReason: record.factorSelectionReason ?? 'HISTORICAL_SNAPSHOT',
    factorSelectionExplanation: record.factorSelectionExplanation ?? 'Stored historical result; current factor library was not used.',
    calculatedEmission: value, calculatedEmissionsKgCO2e: value,
    calculationFormula: `${Number(record.quantity)} ${record.unit} × ${factorValue} kgCO2e/${factorUnit} = ${value} kgCO2e`,
    scope: record.scope ?? scopeForActivity(record.activityType), calculationSnapshotVersion: 0,
    calculatedAt: metric?.calculationDate?.toISOString?.() ?? record.createdAt?.toISOString?.() ?? null,
    snapshotSource: metricValue !== null ? 'PERSISTED_METRIC' : 'LEGACY_ACTIVITY_FIELDS' };
}
