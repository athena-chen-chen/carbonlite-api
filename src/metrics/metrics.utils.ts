import { ActivityType, ConversionFactor, MetricType } from '@prisma/client';

type MatchFactorInput = {
  activityType: ActivityType;
  unit: string;
  factors: ConversionFactor[];
  metricType: MetricType;
};

export function matchBestFactor(input: MatchFactorInput): ConversionFactor | null {
  const { activityType, unit, factors, metricType } = input;

  const candidates = factors.filter((factor) => {
    const activityMatches =
      factor.activityType === activityType || factor.activityType === null;

    const unitMatches = factor.unit.toLowerCase() === unit.toLowerCase();

    const factorMatchesMetric =
      (metricType === 'CARBON_EMISSION' && factor.type === 'EMISSION') ||
      (metricType === 'ENERGY_CONSUMPTION' && factor.type === 'ENERGY') ||
      (metricType === 'COST_ESTIMATE' && factor.type === 'COST') ||
      (metricType === 'CUSTOM' && factor.type === 'CUSTOM');

    return activityMatches && unitMatches && factorMatchesMetric;
  });

  const preferredDefault = candidates.find((f) => f.isDefault);
  return preferredDefault ?? candidates[0] ?? null;
}