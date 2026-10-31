import { DocumentExtractionService } from './document-extraction.service';

function service() {
  return new DocumentExtractionService(
    {} as never,
    { log: jest.fn() } as never,
    { track: jest.fn() } as never,
    {} as never,
  );
}

function reviewRow(activityMetadata: unknown) {
  return {
    status: 'READY',
    activityType: 'AIR_TRAVEL',
    recordDate: new Date('2026-04-10T00:00:00.000Z'),
    quantity: 4280,
    unit: 'km',
    activityMetadata,
    rawSourceRow: {
      passengerKm: 1,
      haulCategory: 'SHORT',
      oneWayDistanceKm: 1,
    },
  } as any;
}

describe('spreadsheet review Air Travel metadata', () => {
  it('uses the persisted v1 route and ignores client-supplied derived values', () => {
    const result = (service() as any).buildImportActivityFromReviewRow(reviewRow({
      schemaVersion: 1,
      type: 'AIR_TRAVEL',
      originAirport: 'yyc',
      destinationAirport: 'lhr',
      passengerCount: 2,
      tripType: 'ROUND_TRIP',
    }));

    expect(result).toMatchObject({
      unit: 'passenger-km',
      activityMetadata: {
        originAirport: 'YYC',
        destinationAirport: 'LHR',
        passengerCount: 2,
        tripType: 'ROUND_TRIP',
      },
    });
    expect(result.quantity).toBeGreaterThan(20_000);
  });

  it.each([
    ['unknown airport', { schemaVersion: 1, type: 'AIR_TRAVEL', originAirport: 'ZZZ', destinationAirport: 'YYZ', passengerCount: 1, tripType: 'ONE_WAY' }],
    ['same airport', { schemaVersion: 1, type: 'AIR_TRAVEL', originAirport: 'YYC', destinationAirport: 'YYC', passengerCount: 1, tripType: 'ONE_WAY' }],
    ['non-integer passengers', { schemaVersion: 1, type: 'AIR_TRAVEL', originAirport: 'YYC', destinationAirport: 'YYZ', passengerCount: 1.5, tripType: 'ONE_WAY' }],
  ])('fails closed for %s', (_name, metadata) => {
    expect((service() as any).buildImportActivityFromReviewRow(reviewRow(metadata))).toMatchObject({
      quantity: 4280,
      unit: 'km',
      activityMetadata: undefined,
    });
  });
});
