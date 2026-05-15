import { ActivityType, ConversionFactor, MetricType } from '@prisma/client';

type MatchFactorInput = {
  activityType: ActivityType;
  unit: string;
  factors: ConversionFactor[];
  metricType: MetricType;
  organizationId: string;
};

export function normalizeUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase().replace(/\s+/g, ' ');

  const aliases: Record<string, string> = {
    night: 'nights',
    nights: 'nights',
    liter: 'liters',
    liters: 'liters',
    litre: 'liters',
    litres: 'liters',
    l: 'liters',
    km: 'km',
    kilometer: 'km',
    kilometers: 'km',
    kilometre: 'km',
    kilometres: 'km',
    kwh: 'kwh',
    'kw h': 'kwh',
    'kilowatt hour': 'kwh',
    'kilowatt hours': 'kwh',
  };

  return aliases[normalized] ?? normalized;
}

export function matchBestFactor(input: MatchFactorInput): ConversionFactor | null {
  const { activityType, unit, factors, metricType, organizationId } = input;
  const normalizedInputUnit = normalizeUnit(unit);

  const candidates = factors.filter((factor) => {
    const activityMatches =
      factor.activityType === activityType || factor.activityType === null;

    const unitMatches = normalizeUnit(factor.unit) === normalizedInputUnit;

    const factorMatchesMetric =
      (metricType === 'CARBON_EMISSION' && factor.type === 'EMISSION') ||
      (metricType === 'ENERGY_CONSUMPTION' && factor.type === 'ENERGY') ||
      (metricType === 'COST_ESTIMATE' && factor.type === 'COST') ||
      (metricType === 'CUSTOM' && factor.type === 'CUSTOM');

    return activityMatches && unitMatches && factorMatchesMetric;
  });

  const organizationCandidates = candidates.filter(
    (factor) => factor.organizationId === organizationId,
  );
  const preferredOrganizationDefault = organizationCandidates.find(
    (factor) => factor.isDefault,
  );

  if (preferredOrganizationDefault) return preferredOrganizationDefault;
  if (organizationCandidates[0]) return organizationCandidates[0];

  const preferredSystemDefault = candidates.find(
    (factor) => factor.isSystemDefault,
  );
  const preferredDefault = candidates.find((factor) => factor.isDefault);

  return preferredSystemDefault ?? preferredDefault ?? candidates[0] ?? null;
}
