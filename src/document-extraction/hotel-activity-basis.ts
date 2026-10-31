export type HotelActivityBasis = {
  rooms: number;
  nights: number;
  roomNights: number;
  derivation: 'ROOMS_X_NIGHTS';
};

const positiveNumber = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function deriveHotelActivityBasis(input: { activityType?: unknown; rooms?: unknown; nights?: unknown }) {
  if (String(input.activityType ?? '').trim().toUpperCase() !== 'HOTEL') return { status: 'ABSENT' as const };
  const hasRooms = input.rooms !== null && input.rooms !== undefined && String(input.rooms).trim() !== '';
  const hasNights = input.nights !== null && input.nights !== undefined && String(input.nights).trim() !== '';
  if (!hasRooms && !hasNights) return { status: 'ABSENT' as const };
  const rooms = positiveNumber(input.rooms);
  const nights = positiveNumber(input.nights);
  if (rooms === null || nights === null) return { status: 'INVALID' as const };
  if (rooms === undefined || nights === undefined) return { status: 'INCOMPLETE' as const, rooms, nights };
  return {
    status: 'DERIVED' as const,
    basis: { rooms, nights, roomNights: rooms * nights, derivation: 'ROOMS_X_NIGHTS' as const },
  };
}

export function readHotelBasisColumns(row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const read = (aliases: string[]) => entries.find(([key]) =>
    aliases.includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')),
  )?.[1];
  return { rooms: read(['rooms', 'roomcount', 'numberofrooms']), nights: read(['nights', 'nightcount', 'numberofnights']) };
}
