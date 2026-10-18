# Official Alberta renewable electricity grid displacement, 2026

This narrowly scoped library load uses the same Prisma upsert mechanism as
`prisma/seed.ts`, without running its demo organization, user, or factor updates.
It is separate from the Docker-only Task 7 fixture seed and from the general
seed command. It is intended for Neon **development only**.

Before running it, confirm in Neon that the endpoint in `.env.neon.local`
belongs to the `development` branch. `NEON_DEVELOPMENT_HOST` must match the
selected URL. An endpoint hostname alone cannot establish a branch name.
No connected Neon management API currently verifies that name automatically.

```sh
npm run seed:alberta-egdf:neon -- --confirmed-development-endpoint=<confirmed-endpoint-id>
```

Use the endpoint ID without `-pooler` or the DNS suffix. The command reads
`.env.neon.local` explicitly, rejects a different endpoint, disables local
fixture settings through the existing environment loader, and never prints
credentials. Do not run against Neon main, production, staging, or a local
fixture database. No migration is needed beyond Task 7.

The single transaction creates these records:

- Source: `official-source-alberta-carbon-offset-emission-factors-handbook-3-2`.
- Factor: `factor_c858db65a889f4f6031e38658341f45f`, using the existing library
  migration's `factor_` + MD5 of `activityType|displayName|inputUnit` convention.
- Version: unique `(factorId, version)` identity, readable version `2026.1`,
  generated Prisma record ID following the existing governed seed convention.
- Legacy Admin projection: the same stable factor ID in `ConversionFactor`.
  This is required because Admin Factors reads that table. It does not create
  a second independently governed factor.

Running the command again creates no additional records and preserves subsequent
governance edits. A different factor using the same display name stops the load
for review; fixture IDs are never reused or silently promoted.

The pinned source is [Carbon Offset Emission Factors Handbook, version 3.2](https://open.alberta.ca/dataset/f2109d83-2153-4481-a8b8-b00178e53999/resource/316751cf-0387-4acd-8e03-cd134bc4a5b2/download/epa-carbon-offset-emission-factors-handbook-v3-2-2025-08.pdf),
Government of Alberta / Alberta Environment and Protected Areas, published
August 20, 2025. Table 1 on page 5 lists the 2026 vintage of electricity grid
displacement with renewable generation as **0.4303 tCO2e/MWh**. Source year is
2025; factor year is 2026. The original units are stored directly, without
normalization or rounding. The line-loss factor and other vintages are excluded.

The factor and source are active; the version has status `OFFICIAL` and confidence
`OFFICIAL_GOVERNMENT`. `verified=false` deliberately makes no claim of a separate
CarbonLite reviewer verification. Applicability is `ALBERTA_OFFSET_PROJECT`,
emission basis is `DIRECT_CO2E`, and the methodology is `Grid Displacement`.
The legacy projection has `isDefault=false`. Its `isSystemDefault=true` flag
provides shared-library visibility, as required by the current Admin query;
the existing applicability guard excludes both representations from ordinary
corporate inventory matching. No offset workflow is introduced.

For review, run the seed twice on the confirmed development branch, verify one
record per stable identity, compare pre-existing factor records, and confirm
1000 kWh of Alberta corporate electricity in 2026 still yields 530 kgCO2e using
the existing 0.53 factor. Focused backend coverage is in
`alberta-egdf-2026.spec.ts`; the sibling frontend's
`src/test/officialAlbertaEgdf.test.tsx` renders these exact seed records and tests
both original and equivalent-unit offset candidates. Keep Golden A/B/C at
579.40 / 338.06 / 2428.44 kgCO2e.
