# ECCC refined-petroleum production factors, 2026

This paid-pilot pack adds new reviewed gasoline and diesel identities. It does
not modify or promote the CarbonLite demo/default factors, and it does not
rewrite historical calculation snapshots.

## Authoritative inputs and derivation

The component factors are from Environment and Climate Change Canada,
[Emission factors and reference values, version 4.0 (September 2026), Table
4.3](https://www.canada.ca/en/environment-climate-change/services/climate-change/pricing-pollution-how-it-will-work/output-based-pricing-system/federal-greenhouse-gas-offset-system/emission-factors-reference-values.html).
Table 4.3 applies to calendar-year 2026 and cites ECCC (2025), *National
Inventory Report 1990–2023*, Part 2, Table A6.1-6, “Emission Factors for
Refined Petroleum Products.” Table 4.4 is based on the 2026 NIR but applies to
2027, so this 2026 pack does not use Table 4.4.

ECCC instructs users to apply the global warming potentials in Schedule 3 to
the *Greenhouse Gas Pollution Pricing Act*. For 2026 those are CO2 = 1,
CH4 = 28, and N2O = 265. CarbonLite derives a direct CO2e factor as:

`kg CO2e/L = (g CO2/L + g CH4/L × 28 + g N2O/L × 265) / 1000`

| Fuel/source row | CO2 (g/L) | CH4 (g/L) | N2O (g/L) | Derived factor (kgCO2e/L) |
|---|---:|---:|---:|---:|
| Motor Gasoline | 2307 | 0.100 | 0.02 | 2.3151 |
| Diesel — Refineries and Others | 2681 | 0.078 | 0.022 | 2.689014 |

Both factors are Canada-level, calendar-year 2026, direct-combustion Scope 1
factors. Their structured governance is `VERIFIED`, `verified=true`,
`CORPORATE_INVENTORY`, and `DIRECT_CO2E`; source and factor identities are not
part of automatic eligibility.

## Development load

No database migration is required. The loader is hard-wired to the existing
local-development guard, which accepts only `localhost:5432/carbonlite_dev`.
Load only this pack with:

```sh
npm run seed:eccc-refined-petroleum:localdb
```

The loader creates one source, two governed factors and their two legacy Admin
projections. Empty upsert updates make reruns non-destructive and preserve later
governance edits. The loader is not run as part of the general demo seed.
