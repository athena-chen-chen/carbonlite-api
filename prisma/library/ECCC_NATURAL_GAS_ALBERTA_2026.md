# ECCC Alberta natural-gas production factor, 2026

This paid-pilot library entry covers Scope 1 stationary combustion of
utility-supplied marketable natural gas at a commercial/institutional Alberta
facility. It does not promote or modify the existing 49.44 kgCO2e/GJ
Canada-generic reference or the 1.89 kgCO2e/m3 demo factor.

## Authoritative inputs and derivation

The inputs are from Environment and Climate Change Canada,
[Emission factors and reference values, version 4.0 (September 2026)](https://www.canada.ca/en/environment-climate-change/services/climate-change/pricing-pollution-how-it-will-work/output-based-pricing-system/federal-greenhouse-gas-offset-system/emission-factors-reference-values.html):

- Table 1.3: Alberta marketable natural gas CO2 = 1962 g/m3
- Table 2.3: Commercial/Institutional CH4 = 0.037 g/m3 and N2O = 0.035 g/m3
- Table 8: gaseous natural gas HHV = 38.39 MJ/m3
- AR5 100-year GWPs: CO2 = 1, CH4 = 28, N2O = 265

The ECCC HHV is used so the volume-based components and energy conversion stay
inside one authoritative methodology:

```text
CO2e = 1962 + (0.037 x 28) + (0.035 x 265)
      = 1972.311 gCO2e/m3

1972.311 / 38.39
      = 51.3756446991404 gCO2e/MJ
      = 51.3756446991404 kgCO2e/GJ
```

This is an HHV (gross calorific value) basis, at the Canadian standard gas
conditions of 15 C and 101.325 kPa. It does not use the general CRA conversion
of 26.853 m3/GJ, which is inconsistent with the selected ECCC 38.39 MJ/m3 HHV.

The governed version is calendar-year 2026, Alberta/Canada,
`CORPORATE_INVENTORY`, `DIRECT_CO2E`, `VERIFIED`, reviewed and approved for
automatic calculation through the existing metadata predicate.

## Development load

No database migration is required. The loader uses the guarded Neon
development configuration and requires explicit confirmation of the configured
endpoint ID:

```sh
npm run seed:eccc-natural-gas-alberta:neon -- --confirmed-development-endpoint=<endpoint-id>
```

It creates one source, one governed factor/version and one legacy API
projection. Empty upsert updates make reruns non-destructive. The loader is not
part of the general demo seed and was not run during implementation.
