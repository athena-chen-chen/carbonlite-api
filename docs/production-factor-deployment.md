# Production factor deployment gate

The paid-pilot production manifest contains exactly 21 reviewed factors. Loading is an explicit deployment operation; API startup never seeds factors.

## Controlled paid-pilot deployment order

Do not skip or reorder these gates:

1. Verify production database PITR/backups and the documented retention window.
2. Verify the durable document-storage backup or snapshot.
3. Take and record one paired pre-deployment recovery point.
4. Record the exact backend and frontend RC commit SHAs and deployment IDs.
5. Configure production environment variables and secrets without logging values.
6. Run `pnpm exec prisma migrate deploy`. Production must never require `migrate dev`.
7. Run `pnpm factors:load:production -- --dry-run`.
8. Set `APP_ENV=production`, `NODE_ENV=production`, and the one-run interlock `ALLOW_PRODUCTION_FACTOR_LOAD=true`.
9. Run `pnpm factors:load:production` to load the canonical 21-factor manifest.
10. Immediately set `ALLOW_PRODUCTION_FACTOR_LOAD=false` or remove it.
11. Run `pnpm factors:verify:production`; this is read-only.
12. Require `PRODUCTION FACTOR GATE: PASS` with exactly 21 expected, present, and eligible factors.
13. Deploy or start the backend at the recorded SHA.
14. Require liveness, database readiness, and document-storage startup health to pass.
15. Deploy the frontend at the recorded SHA with `VITE_APP_VERSION` set to the RC identifier or commit SHA.
16. Run the isolated synthetic Organization smoke described below.
17. Reconcile Dashboard, Formal Report, CSV, and PDF totals.
18. Verify authenticated source download and retained-source integrity.
19. Erase the synthetic Organization through the supported erasure workflow and verify completion.
20. Authorize the first real CUSTOMER invitation only after every preceding gate passes.

The loader prints only the environment, database name, host classification, and expected factor count. It never prints database credentials. The dry run and verification command are read-only. The verification command is the deployment gate and emits a nonzero exit code for missing, altered, ineligible, competing, or unsafe legacy factors.

No manual SQL is part of this deployment. API startup does not seed factors.

## Synthetic Organization smoke

Create a new disposable CUSTOMER Organization with no Golden Sample data. Download the current CarbonLite spreadsheet template and import these eight records, using 2026 dates and unique `RC-SMOKE-*` source references:

| Record | Activity | Input |
|---|---|---|
| 1 | Alberta Electricity | 100 kWh, Canada, Alberta |
| 2 | Alberta Natural Gas | 1 GJ, Canada, Alberta |
| 3 | Alberta Natural Gas | 1 m3, Canada, Alberta |
| 4 | Gasoline | 10 L, Canada, Alberta |
| 5 | Diesel | 10 L, Canada, Alberta |
| 6 | Hotel | 2 rooms x 3 nights, Canada, Alberta |
| 7 | Air Travel | YYC to YYZ, 1 passenger, round trip |
| 8 | Intentionally unresolved | Electricity with Province blank |

Acceptance requires records 1-7 to calculate with the reviewed production factors, record 8 to remain visibly Needs review and excluded from totals, and Hotel to appear exactly once. Data Records, Dashboard, the canonical Formal Report, CSV, and PDF must agree. The Scope 2 disclosure must be location-based and must not show a market-based zero. Verify authenticated source download, the customer-safe read-only Methodology & emission factors view, tenant isolation, and customer-admin/platform-admin separation. Do not record production credentials or customer data in smoke evidence.

## Abort and rollback

Abort immediately if any migration fails; the factor gate is not PASS; the expected/present/eligible factor count is not exactly 21; database, readiness, or storage health fails; synthetic upload/download fails; CUSTOMER onboarding contains Golden Sample data; customer-admin/platform-admin separation fails; an unresolved record is treated as zero or included; or Dashboard/report/CSV/PDF totals disagree.

Keep customer onboarding disabled. Do not improvise manual SQL or reload factors repeatedly. Follow `paid-pilot-recovery.md` using the recorded paired pre-deployment recovery point and redeploy the previously recorded backend/frontend SHA pair. Resume only after database, storage, factor, authorization, tenant, and reporting gates pass again.
