import 'reflect-metadata';
import { snapshotFactorProvenance, isInventoryFactorEligible } from './factor-governance';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateFactorVersionDto } from './dto/create-factor-version.dto';

describe('factor provenance', () => {
  it('fails closed for known reference-only methods and unsafe result dimensions', () => {
    expect(
      isInventoryFactorEligible({
        id: 'eccc-natural-gas-canada-generic-gj-2025',
        resultUnit: 'kgCO2e',
      }),
    ).toBe(false);
    expect(
      isInventoryFactorEligible({
        resultUnit: 'kgCO2e',
        methodologyProvenance: { sourceVersion: 'ECCC_REFERENCE_2026' },
      }),
    ).toBe(false);
    expect(
      isInventoryFactorEligible({ inputUnit: 'L', resultUnit: 'g CO2/L' }),
    ).toBe(false);
    expect(
      isInventoryFactorEligible({ inputUnit: 'kWh', resultUnit: 'kgCO2e/GJ' }),
    ).toBe(false);
    expect(
      isInventoryFactorEligible({ inputUnit: 'litres', resultUnit: 'kgCO2e/L' }),
    ).toBe(true);
  });
 it('captures source version, source year, publication date, factor vintage and historical identity separately', () => {
  const factor = { id: 'version-2026', factorId: 'egdf', version: '2026.1', factorYear: 2026,
    applicability: 'ALBERTA_OFFSET_PROJECT', emissionBasis: 'DIRECT_CO2E',
    sourceTable: 'Table 1', methodologyProvenance: { methodologyVersion: '2.3', methodologyMethod: 'Method 1-1', methodologyLevel: 'Level 1', gwpSource: 'Reference', gwpVersion: 'AR5' },
    source: { sourceAuthority: 'Alberta Environment and Protected Areas', sourceDocument: 'Carbon Offset Emission Factors Handbook', sourceVersion: '3.2', sourceYear: 2025, publishedDate: new Date('2025-08-20') } };
  const snapshot = snapshotFactorProvenance(factor);
  factor.source.sourceVersion = '3.3'; factor.methodologyProvenance.methodologyVersion = '2.4'; factor.version = '2027.1';
  expect(snapshot).toMatchObject({ factorId: 'egdf', factorVersionId: 'version-2026', factorVersion: '2026.1', sourceVersion: '3.2', sourceYear: 2025, factorYear: 2026, publishedDate: '2025-08-20T00:00:00.000Z', methodologyProvenance: { methodologyVersion: '2.3' } });
  expect(isInventoryFactorEligible(factor)).toBe(false);
 });
 it('validates structured governance and rejects arbitrary contexts and gas bases', async () => {
  expect(await validate(plainToInstance(CreateFactorVersionDto, { applicability: 'ALBERTA_OFFSET_PROJECT', emissionBasis: 'CO2_COMPONENT', methodologyProvenance: { methodologyVersion: '2.3', sectorApplicability: ['Industrial'], quantityBasis: 'ENERGY_HHV' } }))).toEqual([]);
  expect((await validate(plainToInstance(CreateFactorVersionDto, { applicability: 'Official', emissionBasis: 'Energy', methodologyProvenance: { sectorApplicability: 'Industrial', quantityBasis: 'UNIVERSAL_GJ_M3' } }))).length).toBe(3);
 });
});
