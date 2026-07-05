import { DocumentExtractionService } from './document-extraction.service';

describe('DocumentExtractionService import normalization', () => {
  const service = new DocumentExtractionService(null as never, null as never, null as never);

  function normalize(activity: Record<string, unknown>) {
    return (service as any).normalizeActivityForImport(activity);
  }

  it('maps province aliases into normalized jurisdiction fields', () => {
    const normalized = normalize({
      ActivityType: 'Electricity',
      Date: '2026-06-30',
      Quantity: 1000,
      Unit: 'kWh',
      Province: 'BC',
      Country: 'CA',
      'Source Reference': 'BC Hydro bill',
    });

    expect(normalized).toMatchObject({
      activityType: 'ELECTRICITY',
      jurisdictionCountry: 'Canada',
      jurisdictionRegion: 'British Columbia',
      sourceReference: 'BC Hydro bill',
    });
  });

  it.each([
    ['Hotel', 'HOTEL'],
    ['Hotels', 'HOTEL'],
    ['Hotel Stay', 'HOTEL'],
    ['Accommodation', 'HOTEL'],
    ['Lodging', 'HOTEL'],
    ['Natural Gas', 'NATURAL_GAS'],
    ['Gasoline', 'GASOLINE'],
    ['Water', 'WATER'],
  ])('maps %s to %s', (rawType, expectedType) => {
    const normalized = normalize({
      activityType: rawType,
      recordDate: '2026-06-30',
      quantity: 3,
      unit: rawType === 'Water' ? 'm3' : 'nights',
      jurisdictionRegion: 'British Columbia',
      jurisdictionCountry: 'Canada',
    });

    expect(normalized.activityType).toBe(expectedType);
  });

  it('supports Jurisdiction Region and State/Province headers', () => {
    expect(
      normalize({
        activityType: 'Electricity',
        recordDate: '2026-06-30',
        quantity: 1000,
        unit: 'kWh',
        'Jurisdiction Region': 'AB',
      }).jurisdictionRegion,
    ).toBe('Alberta');

    expect(
      normalize({
        activityType: 'Electricity',
        recordDate: '2026-06-30',
        quantity: 1000,
        unit: 'kWh',
        'State/Province': 'Ont.',
      }).jurisdictionRegion,
    ).toBe('Ontario');
  });
});
