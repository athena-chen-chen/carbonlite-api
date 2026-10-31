# DESNZ 2026 hotel and air-travel review

## Hotel — approved factor, constrained unit

The authoritative source is the UK Department for Energy Security and Net
Zero (DESNZ), [2026 Government greenhouse gas conversion factors for company
reporting](https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026),
using the revised flat file published 31 July 2026 and methodology section 11.

The published Canada result is **7.4 kgCO2e per room per night**. DESNZ says
the hotel factors support Scope 3 overnight business-travel reporting. The
underlying benchmark is the Cornell Hotel Sustainability Benchmarking Index
2021: annual data from international hotel organizations, expressed as a
country median across hotel classes. DESNZ states that these values have not
changed since the 2022 conversion-factor release.

The basis is an occupied **room-night**, not a person-night. Guest occupancy
does not alter the factor; booking two rooms for three nights is six
room-nights. The source does not justify converting a generic count of people
or nights into room-nights. It also notes that the benchmark sample is weighted
toward larger, upmarket and branded hotels, and that its aggregate CO2e data
can reflect AR4 or AR5 reporting by contributing hotels. Component gases and
well-to-tank emissions are not supplied.

The Factor Library record is therefore reviewed and approved for Canada,
calendar-year 2026, corporate Scope 3 business travel, but its unit is
`room-night`. CarbonLite's existing workbook unit `nights` remains unmatched
unless the input contract is changed to state that quantity means occupied
rooms multiplied by nights. The current row does not contain room count, so it
must remain blocked (`UNIT_MISMATCH` in the frontend evaluation); `3 x 7.4 =
22.2 kgCO2e` is only the conditional result if one occupied room for three
nights is established.

## Air travel — no approved production factor

DESNZ methodology section 9 covers corporate Scope 3 business air travel and
publishes factors per **passenger-kilometre**, not aircraft-kilometre. Published
factors use route-specific domestic/short-haul/long-haul categories, passenger
load factors, and cabin-class allocation. They already include an 8% flown-
distance uplift. Separate tables are provided with and without radiative
forcing; DESNZ's central RF multiplier is 1.7 and is applied to the direct CO2
component, with acknowledged scientific uncertainty.

The current `4,280 km` row does not establish:

- whether the quantity is passenger-km, route distance, or aircraft-km;
- structured origin and destination needed to classify the route;
- passenger count (if the recorded distance is a route distance);
- cabin class; or
- the organization's radiative-forcing reporting policy.

The supporting filename is not authoritative structured route data. In
addition, DESNZ's domestic category means a flight starting and ending in the
UK, so it cannot be silently applied to a Canadian domestic route. No generic
`kgCO2e/km` production factor is created, and the legacy 0.115 factor remains
ineligible. The row stays `FACTOR_NOT_APPROVED` until the fields above are
captured and an authoritative geographically applicable factor set is selected.

## Development load

No database migration is required. The hotel loader is idempotent and guarded
for an explicitly confirmed Neon development endpoint:

```sh
npm run seed:desnz-hotel-canada:neon -- --confirmed-development-endpoint=<endpoint-id>
```

It was not run during this review. There is no air-travel loader because no
production factor was approved.
