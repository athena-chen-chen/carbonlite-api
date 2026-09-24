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


  it('keeps ENMAX-style utility usage rows and drops CAD billing charges', () => {
    const rows = [
      {
        activityType: 'ELECTRICITY',
        recordDate: '2026-08-01',
        quantity: 358,
        unit: 'kWh',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Electricity USE(kWh)',
      },
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-08-01',
        quantity: 3,
        unit: 'GJ',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Natural Gas USE(GJ)',
      },
      {
        activityType: 'WATER',
        recordDate: '2026-08-01',
        quantity: 6,
        unit: 'm3',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Water Treatment and Supply USE(m3)',
        notes: 'Water usage is tracked only.',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-08-01',
        quantity: 19.54,
        unit: 'CAD',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Waste and Recycling $19.54',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-08-01',
        quantity: 2.17,
        unit: '$',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Blue Cart Program Charge $2.17',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-08-01',
        quantity: 236.63,
        unit: 'CAD',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'Total amount due $236.63',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-08-01',
        quantity: 4.18,
        unit: 'CAD',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Alberta',
        sourceReference: 'GST',
      },
    ];

    const filtered = (service as any).filterOperationalActivityRows(rows);

    expect(filtered).toHaveLength(3);
    expect(filtered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activityType: 'ELECTRICITY', quantity: 358, unit: 'kWh' }),
        expect.objectContaining({ activityType: 'NATURAL_GAS', quantity: 3, unit: 'GJ' }),
        expect.objectContaining({ activityType: 'WATER', quantity: 6, unit: 'm3' }),
      ]),
    );
    expect(filtered).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: 'CAD' }),
        expect.objectContaining({ unit: '$' }),
      ]),
    );
  });

  it('drops charge-like rows even when currency appears in the source reference text', () => {
    const filtered = (service as any).filterOperationalActivityRows([
      {
        activityType: 'CUSTOM',
        recordDate: '2026-08-01',
        quantity: 9.98,
        unit: 'charge',
        sourceReference: 'Green Cart Program Charge $9.98',
      },
      {
        activityType: 'WATER',
        recordDate: '2026-08-01',
        quantity: 6,
        unit: 'm3',
        sourceReference: 'Water USE(m3)',
      },
    ]);

    expect(filtered).toEqual([
      expect.objectContaining({ activityType: 'WATER', quantity: 6, unit: 'm3' }),
    ]);
  });

  it('accepts JSON uploads as supported extraction files', () => {
    expect(() =>
      (service as any).validateSupportedFile({
        id: 'doc-json',
        organizationId: 'org-1',
        fileName: 'carbonlite-activity-records.json',
        mimeType: 'application/json',
      }),
    ).not.toThrow();
  });

  it('normalizes amount from structured JSON records', () => {
    const normalized = normalize({
      activityType: 'Electricity',
      date: '2026-06-30',
      amount: 1250,
      unit: 'kWh',
      province: 'AB',
      sourceReference: 'upload.json',
    });

    expect(normalized).toMatchObject({
      activityType: 'ELECTRICITY',
      recordDate: '2026-06-30',
      quantity: 1250,
      unit: 'kWh',
      jurisdictionRegion: 'Alberta',
      sourceReference: 'upload.json',
    });
  });

  it('builds JSON extraction preview rows without rejecting incomplete records', () => {
    const previewRow = (service as any).normalizeActivityForExtraction(
      {
        activityType: 'Electricity',
        amount: '1250',
        unit: 'kWh',
        province: 'AB',
      },
      'upload.json',
    );

    expect((service as any).addConfidence(previewRow)).toMatchObject({
      activityType: { value: 'ELECTRICITY', confidence: 'high' },
      recordDate: { value: null, confidence: 'low' },
      quantity: { value: 1250, confidence: 'high' },
      jurisdictionRegion: { value: 'Alberta', confidence: 'high' },
      sourceReference: { value: 'upload.json', confidence: 'high' },
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
