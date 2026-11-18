/** Unit-only fixture: represents a committed admission; PostgreSQL tests cover
 * the real admission service. This never replaces production authorization. */
export function extractionOperationsFixture(document: Record<string, unknown>) {
  return {
    admit: jest.fn().mockResolvedValue({
      document: { ...document, ingestionDataMode: document.ingestionDataMode ?? 'SYNTHETIC_TEST' },
      operation: { id: 'synthetic-unit-operation' }, quotaEnforced: false, release: jest.fn(),
    }),
    lockAndValidate: jest.fn().mockResolvedValue({}),
  };
}
