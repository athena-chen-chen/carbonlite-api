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
    ltr: 'liters',
    km: 'km',
    kilometer: 'km',
    kilometers: 'km',
    kilometre: 'km',
    kilometres: 'km',
    kwh: 'kwh',
    kwhr: 'kwh',
    'kw h': 'kwh',
    'kilowatt hour': 'kwh',
    'kilowatt hours': 'kwh',
    'kilowatt-hour': 'kwh',
    'kilowatt-hours': 'kwh',
    m3: 'm3',
    'm³': 'm3',
    'cubic meter': 'm3',
    'cubic meters': 'm3',
    'cubic metre': 'm3',
    'cubic metres': 'm3',
    kg: 'kg',
    kilogram: 'kg',
    kilograms: 'kg',
    tonne: 'tonne',
    tonnes: 'tonne',
    'metric ton': 'tonne',
    'metric tons': 'tonne',
    ton: 'ton',
    tons: 'ton',
    'ton-km': 'ton-km',
    'tonne-km': 'ton-km',
    tkm: 'ton-km',
  };

  return aliases[normalized] ?? normalized;
}

export function normalizeJurisdictionRegion(region?: string | null): string | null {
  const raw = String(region ?? '').split(',')[0];
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\(generic\)/g, '')
    .replace(/\s+/g, ' ');

  if (!normalized) return null;

  const aliases: Record<string, string> = {
    ab: 'Alberta',
    alta: 'Alberta',
    alberta: 'Alberta',
    bc: 'British Columbia',
    'b c': 'British Columbia',
    'british columbia': 'British Columbia',
    mb: 'Manitoba',
    man: 'Manitoba',
    manitoba: 'Manitoba',
    nb: 'New Brunswick',
    'new brunswick': 'New Brunswick',
    nl: 'Newfoundland and Labrador',
    nfld: 'Newfoundland and Labrador',
    'newfoundland and labrador': 'Newfoundland and Labrador',
    ns: 'Nova Scotia',
    'nova scotia': 'Nova Scotia',
    nt: 'Northwest Territories',
    'northwest territories': 'Northwest Territories',
    nu: 'Nunavut',
    nunavut: 'Nunavut',
    on: 'Ontario',
    ont: 'Ontario',
    ontario: 'Ontario',
    pe: 'Prince Edward Island',
    pei: 'Prince Edward Island',
    'prince edward island': 'Prince Edward Island',
    qc: 'Quebec',
    que: 'Quebec',
    quebec: 'Quebec',
    québec: 'Quebec',
    sk: 'Saskatchewan',
    sask: 'Saskatchewan',
    saskatchewan: 'Saskatchewan',
    yt: 'Yukon',
    yukon: 'Yukon',
    ca: 'Canada',
    national: 'Canada',
    canada: 'Canada',
    'canada generic': 'Canada',
    'canada national': 'Canada',
    'canada - national': 'Canada',
    'canada-level': 'Canada',
    'not province-specific': 'Canada',
    'province required': 'Province Required',
  };

  return aliases[normalized] ?? titleCase(normalized);
}

export function normalizeJurisdictionCountry(country?: string | null): string | null {
  const normalized = String(country ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (['ca', 'can', 'canada'].includes(normalized)) return 'Canada';
  return titleCase(normalized);
}

function titleCase(value: string) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
