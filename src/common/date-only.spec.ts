import {
  getDateOnlyYear,
  parseDateOnlyRangeEndUtc,
  parseDateOnlyUtc,
  toDateOnlyString,
} from './date-only';

describe('date-only helpers', () => {
  it.each(['2026-07-20', '2026-01-15'])(
    'parses %s as the same UTC calendar date',
    (value) => {
      expect(toDateOnlyString(value)).toBe(value);
      expect(parseDateOnlyUtc(value).toISOString()).toBe(`${value}T00:00:00.000Z`);
    },
  );

  it('derives the year from the date-only portion without timezone conversion', () => {
    expect(getDateOnlyYear('2026-07-20T06:00:00.000Z')).toBe(2026);
  });

  it('builds inclusive date-only range end values', () => {
    expect(parseDateOnlyRangeEndUtc('2026-07-20').toISOString()).toBe(
      '2026-07-20T23:59:59.999Z',
    );
  });
});
