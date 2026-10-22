# F22 date system fixtures

These synthetic XLSX files and expected.json are byte-identical copies of the frontend test-fixtures/xlsx-date-systems/ files. The frontend generate.mjs creates both workbooks with explicit metadata and independent modern-date serial arithmetic. It uses no calculation/factor fixtures.

Both workbooks encode nine identical logical rows: five modern dates including leap day and year boundaries, a noon serial, literal text, a cached formula date, and an unformatted serial. Dates includes physical row provenance. For 2026-01-15, the serial is 46037 (1900) or 44575 (1904).

To regenerate, run the frontend generator, then copy both XLSX files and expected.json here unchanged. Do not use JS Date cells in the fixture writer: installed SheetJS 0.18.5 has Date conversion/epoch quirks. Raw numeric serial cells make the oracle explicit.

Run the backend spreadsheet-date-systems unit and E2E tests. The frontend scripts/regression/xlsx-date-parity.mjs runner additionally exercises its real browser component and this backend parser on the same bytes. Database-backed tests must use the existing F20 guard.
