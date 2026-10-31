import { deriveHotelActivityBasis } from './hotel-activity-basis';
import { CalculationSnapshotsService } from '../metrics/calculation-snapshots.service';

describe('deriveHotelActivityBasis', () => {
  it('derives room-night from two explicit positive inputs', () => {
    expect(deriveHotelActivityBasis({ activityType: 'HOTEL', rooms: 2, nights: 3 })).toEqual({
      status: 'DERIVED',
      basis: { rooms: 2, nights: 3, roomNights: 6, derivation: 'ROOMS_X_NIGHTS' },
    });
  });

  it.each([
    [{ rooms: undefined, nights: 3 }, 'INCOMPLETE'],
    [{ rooms: 2, nights: undefined }, 'INCOMPLETE'],
    [{ rooms: 0, nights: 3 }, 'INVALID'],
    [{ rooms: -2, nights: 3 }, 'INVALID'],
    [{ rooms: 2, nights: 'bad' }, 'INVALID'],
  ])('fails closed for %o', (values, status) => {
    expect(deriveHotelActivityBasis({ activityType: 'HOTEL', ...values }).status).toBe(status);
  });
});

describe('Hotel activity snapshot audit', () => {
  it('keeps the derivation in the snapshot without persisting a transient column', async () => {
    const client = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org' }) },
      conversionFactor: { findMany: jest.fn().mockResolvedValue([]) },
      factorVersion: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const quality = { evaluate: jest.fn().mockReturnValue({ calculationDetails: [{
      status: 'CALCULATED', factorId: 'hotel-factor', factorVersionId: 'hotel-version',
      factorName: 'Canada Hotel', factorValue: 7.4, factorInputUnit: 'room-night',
      factorResultUnit: 'kgCO2e', calculatedEmissionsKgCO2e: 44.4,
      calculationQuantity: 6, calculationFormula: '6 room-night × 7.4 kgCO2e/room-night = 44.4 kgCO2e',
    }] }) };
    const service = new CalculationSnapshotsService(null as never, quality as never);
    const basis = { rooms: 2, nights: 3, roomNights: 6, derivation: 'ROOMS_X_NIGHTS' as const };
    const prepared = await service.prepareCreate(client as never, {
      organizationId: 'org', activityType: 'HOTEL', quantity: 6, unit: 'room-night',
      recordDate: new Date('2026-04-01T00:00:00.000Z'), hotelActivityBasis: basis,
    });

    expect(prepared).not.toHaveProperty('hotelActivityBasis');
    expect(prepared.calculationSnapshot.input.activityBasis).toEqual(basis);
    expect(prepared.calculationSnapshot.detail.calculationFormula)
      .toContain('2 rooms × 3 nights = 6 room-night');
  });
});
