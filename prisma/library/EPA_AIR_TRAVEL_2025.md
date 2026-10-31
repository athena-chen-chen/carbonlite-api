# U.S. EPA air-travel production factors, 2025

This pack uses Table 10 of the U.S. EPA **2025 GHG Emission Factors Hub** for
Scope 3 Category 6 business travel. It stores the published CO2, CH4 and N2O
components for short-, medium- and long-haul air travel and derives aggregate
CO2e with EPA AR5 100-year GWPs (CO2 1, CH4 28, N2O 265). Published
passenger-mile results are divided by exactly 1.609344 to create the
`passenger-km` production factors.

The haul bands use the already committed server-derived one-way route miles:
short is below 300 miles, medium is at least 300 and below 2300 miles, and long
is at least 2300 miles. Passenger-km is never used to infer haul. Cabin class is
not part of EPA v0.1 selection.

The accounting boundary is combustion/direct GHG only. Aviation non-CO2 and
radiative-forcing effects are excluded, well-to-tank is excluded/deferred, and
CarbonLite applies no additional 8% distance uplift. This is a U.S. EPA
methodology used as a North American paid-pilot proxy; it is not a Canadian
official factor.

Source: [U.S. EPA 2025 GHG Emission Factors Hub](https://www.epa.gov/system/files/documents/2025-01/ghg-emission-factors-hub-2025.pdf),
January 2025, Table 10.

The loader is guarded for the explicitly confirmed Neon development endpoint,
uses stable identities and one transaction, and is idempotent. It must never be
run against production, main or staging.

```sh
npm run seed:epa-air-travel:neon -- --confirmed-development-endpoint=<endpoint-id>
```
