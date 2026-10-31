# Production factor deployment gate

The paid-pilot production manifest contains exactly 21 reviewed factors. Loading is an explicit deployment operation; API startup never seeds factors.

Deployment order:

1. Back up the database.
2. Run `npx prisma migrate deploy`.
3. Run `npm run factors:load:production -- --dry-run`.
4. Set `APP_ENV=production` (or `NODE_ENV=production`) and the one-run flag `ALLOW_PRODUCTION_FACTOR_LOAD=true`.
5. Run `npm run factors:load:production`.
6. Remove or disable `ALLOW_PRODUCTION_FACTOR_LOAD` immediately.
7. Run `npm run factors:verify:production` and require exit code 0.
8. Deploy or start the API.
9. Verify the normal application readiness checks.

The loader prints only the environment, database name, host classification, and expected factor count. It never prints database credentials. The dry run and verification command are read-only. The verification command is the deployment gate and emits a nonzero exit code for missing, altered, ineligible, competing, or unsafe legacy factors.
