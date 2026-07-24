const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

export function toDateOnlyString(value: string | Date | null | undefined) {
  if (!value) return null;

  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, '0');
    const day = String(value.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const match = String(value).match(DATE_ONLY_PATTERN);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function parseDateOnlyUtc(value: string | Date) {
  const dateOnly = toDateOnlyString(value);
  if (!dateOnly) return new Date(value);

  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function getDateOnlyYear(value: string | Date | null | undefined) {
  const dateOnly = toDateOnlyString(value);
  if (!dateOnly) return null;

  const year = Number(dateOnly.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export function parseDateOnlyRangeEndUtc(value: string | Date) {
  const start = parseDateOnlyUtc(value);
  start.setUTCHours(23, 59, 59, 999);
  return start;
}
