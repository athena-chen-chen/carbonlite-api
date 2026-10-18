import { DocumentExtractionService } from './document-extraction.service';

describe('DocumentExtractionService import normalization', () => {
  const service = new DocumentExtractionService(null as never, null as never, null as never, null as never);

  function normalize(activity: Record<string, unknown>) {
    return (service as any).normalizeActivityForImport(activity);
  }

  function buildContent(mimeType: string) {
    return (service as any).buildExtractionUserContent({
      fileName: mimeType === 'application/pdf' ? 'bill.pdf' : `bill.${mimeType.split('/')[1]}`,
      mimeType,
      base64: 'ZmFrZS1maXh0dXJl',
    });
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

  it('keeps only current FortisBC-style usage rows when period roles distinguish comparisons', () => {
    const filtered = (service as any).filterOperationalActivityRows([
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-09-24',
        quantity: 2.1,
        unit: 'GJ',
        periodRole: 'CURRENT',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'British Columbia',
        sourceReference: 'Gas charges: Aug 25 - Sep 24, 2026',
        notes: 'Delivery (2.1 GJ x rate).',
      },
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-09-24',
        quantity: 0.7,
        unit: 'GJ',
        periodRole: 'PREVIOUS_PERIOD',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'British Columbia',
        sourceReference: 'Usage comparison chart',
        notes: 'Last bill.',
      },
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-09-24',
        quantity: 2.2,
        unit: 'GJ',
        periodRole: 'PRIOR_YEAR',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'British Columbia',
        sourceReference: 'Usage comparison chart',
        notes: 'Last year.',
      },
    ]);

    expect(filtered).toEqual([
      expect.objectContaining({ activityType: 'NATURAL_GAS', quantity: 2.1, unit: 'GJ', periodRole: 'CURRENT' }),
    ]);
  });

  it('keeps distinct current utility activities from different billing periods', () => {
    const filtered = (service as any).filterOperationalActivityRows([
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-08-24',
        quantity: 1.8,
        unit: 'GJ',
        periodRole: 'CURRENT',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'British Columbia',
        sourceReference: 'Gas charges: Jul 25 - Aug 24, 2026',
      },
      {
        activityType: 'NATURAL_GAS',
        recordDate: '2026-09-24',
        quantity: 2.1,
        unit: 'GJ',
        periodRole: 'CURRENT',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'British Columbia',
        sourceReference: 'Gas charges: Aug 25 - Sep 24, 2026',
      },
    ]);

    expect(filtered).toHaveLength(2);
    expect(filtered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quantity: 1.8, periodRole: 'CURRENT' }),
        expect.objectContaining({ quantity: 2.1, periodRole: 'CURRENT' }),
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

  it('routes JPEG extraction through OpenAI image input instead of generic file input', () => {
    const content = buildContent('image/jpeg');

    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({
          type: 'input_image',
          image_url: expect.stringMatching(/^data:image\/jpeg;base64,/),
          detail: 'high',
        }),
      ]),
    );
    expect(content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'input_file' })]),
    );
  });

  it('routes PNG extraction through OpenAI image input', () => {
    const content = buildContent('image/png');

    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'input_image',
          image_url: expect.stringMatching(/^data:image\/png;base64,/),
          detail: 'high',
        }),
      ]),
    );
  });

  it('keeps PDF extraction on the existing OpenAI file input path', () => {
    const content = buildContent('application/pdf');

    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({
          type: 'input_file',
          filename: 'bill.pdf',
          file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
        }),
      ]),
    );
    expect(content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'input_image' })]),
    );
  });

  it('uses image signatures to keep OpenAI MIME aligned with the actual image format', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    expect(
      (service as any).resolveOpenAiMimeType(
        { fileName: 'upload.bin', mimeType: 'application/octet-stream' },
        jpeg,
      ),
    ).toBe('image/jpeg');
    expect(
      (service as any).resolveOpenAiMimeType(
        { fileName: 'upload.bin', mimeType: 'application/octet-stream' },
        png,
      ),
    ).toBe('image/png');
  });

  it('keeps the sanitized Manitoba Hydro current electricity row and preserves period dates', () => {
    const filtered = (service as any).filterOperationalActivityRows([
      {
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-10',
        periodStart: '2026-02-09',
        periodEnd: '2026-03-10',
        quantity: 3721,
        unit: 'kWh',
        periodRole: 'CURRENT',
        jurisdictionCountry: 'Canada',
        jurisdictionRegion: 'Manitoba',
        sourceReference: 'Manitoba Hydro actual reading current billing period',
        notes: 'Actual reading.',
      },
      {
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-10',
        quantity: 7965,
        unit: 'kWh',
        periodRole: 'HISTORICAL_COMPARISON',
        sourceReference: 'Consumption history',
      },
      {
        activityType: 'ELECTRICITY',
        recordDate: '2026-03-10',
        quantity: 8896,
        unit: 'kWh',
        periodRole: 'PRIOR_YEAR',
        sourceReference: 'Consumption history',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-03-10',
        quantity: 23.42,
        unit: 'CAD',
        sourceReference: 'Basic charge',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-03-10',
        quantity: 180.12,
        unit: 'CAD',
        sourceReference: 'Energy charge',
      },
      {
        activityType: 'CUSTOM',
        recordDate: '2026-03-10',
        quantity: 9.31,
        unit: 'CAD',
        sourceReference: 'Tax',
      },
    ]);
    const previewRows = filtered.map((row: Record<string, unknown>) =>
      (service as any).addConfidence(row),
    );

    expect(filtered).toHaveLength(1);
    expect(previewRows[0]).toMatchObject({
      activityType: { value: 'ELECTRICITY' },
      quantity: { value: 3721 },
      unit: { value: 'kWh' },
      jurisdictionCountry: { value: 'Canada' },
      jurisdictionRegion: { value: 'Manitoba' },
      periodStart: '2026-02-09',
      periodEnd: '2026-03-10',
    });
    expect(filtered.map((row: Record<string, unknown>) => row.quantity)).not.toEqual(
      expect.arrayContaining([7965, 8896, 30946]),
    );
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
