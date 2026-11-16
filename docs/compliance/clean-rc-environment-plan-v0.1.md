# Clean Phase 2 real-data RC environment plan v0.1

## Status and scope

This is a preparation-only plan. It creates no Git refs, infrastructure,
credentials, secrets, customer records, deployments, or database changes.

The proposed environment is a separate **PHASE 2 REAL-DATA RC ENVIRONMENT**.
It is not Production and begins with synthetic/disposable test data only.
Niall, Emerald Sustainability, real customers, Production aliases, Production
secrets, and legacy Preview data are out of scope.

The legacy Render service `carbonlite-rc2-invitation-preview` remains a
**FROZEN HISTORICAL EVIDENCE VERIFIER**. It must not receive this code, ordinary
deployments, configuration repairs, new evidence, real customer data, or new
functional tests.

## 1. Git lineage and release branch

Verified locally:

- repository: `athena-chen-chen/carbonlite-api`
- working branch: `phase2/p0-0-real-data-gate`
- reviewed HMAC architecture base:
  `9a3b9374e4e3fe942001ac5bb910c4c4f0ce306a`
- parent/current remote branch HEAD:
  `2552b60ed866742dbd8dd2e96a6b6391a0115021`
- `2552b60...` is an ancestor of `9a3b937...`
- the deployment candidate consists of two local commits above origin:
  `9a3b937 feat: support additive evidence HMAC keys`, followed by the commit
  containing this optional-provider correction and plan update
- no merge or divergent history is present
- working tree was clean before this plan document was added

The reviewed HMAC implementation base SHA is:

`9a3b9374e4e3fe942001ac5bb910c4c4f0ce306a`

### Recommended branch strategy

Use a dedicated protected branch:

`release/phase2-real-data-rc`

Create it from the exact reviewed deployment candidate containing the
OpenAI-optional startup correction described below. The final full SHA is the
commit containing this plan and is recorded in the implementation validation
report. The branch
must not point the frozen Preview service at the new code. This is safer than
deploying directly from the long-lived feature branch because it provides an
independent promotion boundary, can be protected, and can be bound only to the
new RC service.

`9a3b937...` remains the architecture base. The deployment candidate is its
reviewed descendant containing lazy OpenAI client initialization and the
fail-closed extraction-time provider check. It is not yet remotely available
and must not be deployed until the ordinary branch/release review is approved.

## 2. New Render backend service

Proposed service name:

`carbonlite-phase2-real-data-rc`

Create a new paid Render web service with:

| Setting | Proposed value |
|---|---|
| Repository | `athena-chen-chen/carbonlite-api` |
| Branch | `release/phase2-real-data-rc` |
| Auto-Deploy | OFF |
| PR previews | OFF initially |
| Runtime | Native Node |
| Root directory | repository root |
| Build command | `pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm run build` |
| Pre-deploy command | `DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm exec prisma migrate deploy` |
| Start command | `node dist/main.js` |
| Health check | `/api/health/live` |
| Region | Virginia, USA |
| Release control | manual deployment of an exact reviewed SHA only |

The build and start commands match the authoritative frozen service settings,
but no service environment, environment group, deploy hook, disk, or secret is
to be inherited from that service. Render service-level variables should be
used for RC. Do not link a legacy environment group.

Render currently offers Oregon, Ohio, Virginia, Frankfurt, and Singapore.
Virginia is recommended for this synthetic-only RC because the proposed Neon
database is in AWS US East 1 (N. Virginia), minimizing database latency. This
is an engineering placement decision, not a Canadian residency claim. The
region for any future real-customer or Production environment remains a
**FOUNDER / SECURITY / PRIVACY DECISION**.

References:

- <https://render.com/docs/regions>
- <https://render.com/docs/deploys>
- <https://render.com/docs/configure-environment-variables>

## 3. Clean Neon boundary

The existing Neon project `carbonlite` is in AWS US East 1 (N. Virginia) and
currently has three branches: `main`, `development`, and
`rc2-preupgrade-backup-20261109`. Neither `main` nor `development` is an
acceptable source for a clean RC clone: branching either copies its roles,
schema, and data, which could import Niall, disposable Preview records, or
historical HMAC evidence.

### Recommended database design

Create a completely new Neon project rather than a child branch in the
existing project:

| Object | Proposed identity |
|---|---|
| Project | `carbonlite-phase2-real-data-rc` |
| Region | AWS US East 1 (N. Virginia) |
| Default branch | `main` (protected after creation) |
| Database | `carbonlite_rc` |
| Postgres version | current supported version compatible with the verified schema (the existing project is Postgres 17) |

The project must start from Neon's clean project baseline, not from an existing
CarbonLite data branch. Apply the repository migrations from zero. This gives
the strongest boundary and makes “no Niall / no customer data / no historical
Preview evidence” independently testable.

Neon supports multiple regions, including AWS US East 1 (N. Virginia), AWS US
East 2 (Ohio), and AWS US West 2 (Oregon). Backend and database should remain in
the same geographic region where practical. No Canada-only option or residency
guarantee is established by this plan.

Reference: <https://neon.com/demos/regional-latency>

## 4. Database credentials and migrations

The repository contains 60 migrations. Neither `9a3b937...` nor its
optional-provider descendant introduces a Prisma schema or migration change.
All 60 were previously applied successfully from
zero to a disposable local PostgreSQL database during candidate validation.

Use separate RC-only roles:

| Role | Connection | Privilege boundary |
|---|---|---|
| Neon project owner/admin | direct only; emergency provisioning | Never used by the application or routine deploys |
| `carbonlite_rc_migrator` | direct, non-pooled URL in `MIGRATION_DATABASE_URL` | Owns the RC database/schema and may run reviewed DDL migrations |
| `carbonlite_rc_app` | pooled URL in runtime `DATABASE_URL` | Connect/usage plus application DML and required sequence privileges; no schema creation, role administration, or branch control |

Configure default privileges from the migrator so future migration-created
tables and sequences remain usable by the runtime role. Test both roles before
deployment. Do not use the runtime role for Prisma migrations and do not give
the runtime service the project owner URL.

Render's pre-deploy command runs on a separate instance before the new build is
started. A failed migration must fail the deploy. The application then starts
using only the pooled runtime URL.

### Canonical factors

Migrations do not load the reviewed calculation factor manifest. Before the
manual real-data-mode smoke, run the existing controlled factor process against
the new RC database:

1. `pnpm factors:load:production -- --dry-run`
2. temporarily set the one-run `ALLOW_PRODUCTION_FACTOR_LOAD=true` interlock;
3. run `pnpm factors:load:production` once;
4. immediately remove/reset the interlock;
5. run `pnpm factors:verify:production` and require exactly 21 expected,
   present, and eligible factors.

Despite the command name, this operation targets the isolated RC database and
must record that target explicitly. No Preview or Production database is used.

## 5. HMAC configuration

The clean RC configuration is additive-only:

```text
REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION=rc-v1
REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS={"rc-v1":"base64:<fresh-rc-only-32-byte-or-longer-random-key>"}
```

`REAL_DATA_EVIDENCE_HMAC_KEYRING` must be absent.

The new key is generated only after explicit approval, entered directly into
the new RC service's secret configuration, and never printed, copied into chat,
committed, or shared with Preview/Production. None of `preview-v1` through
`preview-v5` may appear in the service metadata or loaded version list.

Startup acceptance requires safe diagnostics equivalent to:

```text
Evidence HMAC loaded: active=rc-v1 versions=[rc-v1] count=1 legacy=NO additive=YES
```

No key value may appear in logs.

## 6. Authentication and secret boundaries

| Configuration | Classification | RC treatment |
|---|---|---|
| `JWT_SECRET` | Secret; **MUST BE FRESH** | Generate a high-entropy RC-only value. Never share with Preview or Production. Existing tokens must not cross environments. |
| Password/invitation tokens | Database records; **MUST BE FRESH** | Generated by supported workflows in the clean RC database. Do not migrate users or token hashes. |
| `ADMIN_SCRIPT_TOKEN` | Secret; **SHOULD NOT BE SHARED** | Keep absent unless a separately approved operator workflow requires it; otherwise use authenticated platform-admin UI. |
| Recovery authority/control variables | Secrets/controlled metadata; **VERIFY BEFORE ENABLE** | Keep recovery mode disabled/normal unless the recovery runbook explicitly provisions an RC-specific authority. Never copy Preview recovery state. |
| `OPENAI_API_KEY` | Secret; **MUST BE FRESH IF LATER ENABLED** | Absent for initial non-AI RC after the startup optionality fix. Never copy Preview or Production. |
| HMAC additive key | Secret; **MUST BE FRESH** | One RC-only `rc-v1` key. |
| Database URLs/passwords | Secret; **MUST BE FRESH** | New project, roles, and URLs only. |
| CORS/frontend URLs and release labels | Non-secret; environment-specific | Set explicitly to the new RC origins/SHA. |

The only backend session-signing secret currently required by application code
is `JWT_SECRET`; JWTs expire after seven days. Setup/invitation tokens are
random, stored as hashes, and belong to the clean database rather than a shared
signing secret.

## 7. OpenAI posture and startup contract

Initial posture:

`AI PROVIDER DISABLED / NOT CONFIGURED FOR INITIAL NON-AI RC`

Expected settings:

```text
OPENAI_API_KEY=<absent>
REAL_DATA_AI_PROCESSING_ENABLED=false
CARBONLITE_AI_CONSENT_VERSION=<absent>
```

Organization AI authorization remains absent. Manual entry, spreadsheet
import, real-data authorization, and HMAC evidence do not require OpenAI.

**Startup blocker resolved in the deployment-candidate descendant:** the OpenAI
client is now constructed lazily, so a backend with no `OPENAI_API_KEY` starts
and passes live/readiness checks when its other dependencies are healthy.
Provider-independent XLS/XLSX and structured JSON processing remain available.
After organization and AI authorization checks pass, a provider-backed request
without the credential fails before extraction leases, status changes, start
events, document reads, or provider calls with HTTP `503` and code
`AI_PROVIDER_NOT_CONFIGURED`. No fallback provider is used. AI-enabled RC
testing remains deferred until a separate RC-only credential and authorization
are approved.

## 8. Telemetry posture

Initial RC posture:

| Provider | Decision | Configuration |
|---|---|---|
| Backend Sentry | DISABLE | `SENTRY_DSN` absent |
| Frontend Sentry | DISABLE | `VITE_SENTRY_DSN` absent |
| PostHog | DISABLE | `VITE_POSTHOG_KEY` absent; do not rely on host-only configuration |
| GA4 | DISABLE | `VITE_GA_MEASUREMENT_ID` absent |

Enable any provider only after its event schema, identifiers, query handling,
region, contract/DPA, retention, incident access, notice, and consent posture
are approved. This matches the Data Map and Subprocessor findings.

## 9. Uploaded-source storage

The current backend uses `FilesystemDocumentStorage`; deployed runtimes fail
startup unless an explicit durable filesystem root is configured. A normal
Render filesystem is ephemeral, so the RC needs its own persistent disk.

Proposed boundary:

| Setting | Value |
|---|---|
| Disk ownership | new RC service only |
| Mount path | `/var/data` |
| `DOCUMENT_STORAGE_PATH` | `/var/data/carbonlite-documents` |
| `DOCUMENT_STORAGE_DURABLE` | `true` |
| `DOCUMENT_UPLOAD_TEMP_PATH` | `/tmp/carbonlite-document-uploads` |

Do not attach, copy, or mount the frozen Preview disk. Validate the storage
write/read/delete startup probe, upload/download, quarantine, and snapshot
recovery procedure. Render documents that only data under the mount path is
durable and that attached disks receive daily snapshots retained for seven
days: <https://render.com/docs/disks>.

## 10. Environment-variable inventory

| Variable/category | Secret? | Fresh or copied? | Source | Verification |
|---|---:|---|---|---|
| `DATABASE_URL` | Yes | Fresh | Neon pooled URL for `carbonlite_rc_app` | Host/project/branch/database metadata; runtime login; `/health/ready` |
| `MIGRATION_DATABASE_URL` | Yes | Fresh | Neon direct URL for `carbonlite_rc_migrator` | Migration role identity; `prisma migrate status`; no runtime exposure |
| `JWT_SECRET` | Yes | Fresh | Secure generator/Render secret | Presence only; cross-environment token rejection |
| `REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION` | No | Fresh label | `rc-v1` | Safe startup diagnostic |
| `REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS` | Yes | Fresh | Secure generator/Render secret | Loaded labels/count only; evidence sign/verify |
| `REAL_DATA_EVIDENCE_HMAC_KEYRING` | Yes | Not copied; absent | N/A | Confirm source absent and legacy=NO |
| `APP_ENV`, `NODE_ENV` | No | Explicit RC security profile | service config | Health/config metadata; security startup checks |
| `RELEASE_VERSION` | No | Exact SHA | reviewed Git SHA | Health/log/release metadata |
| `FRONTEND_URL` | No | RC-specific | RC frontend origin | Invite URL host only |
| `CORS_ALLOWED_ORIGINS` | No | RC-specific exact origin(s) | RC frontend | Preflight allowed only for exact origin; wildcard denied |
| `TRUST_PROXY_HOPS` | No | Render-specific verified count | Render topology | Startup and forwarded-IP/rate-limit check |
| `PUBLIC_REGISTRATION_ENABLED` | No | Explicit `false` | policy | Registration denied |
| `DEMO_RESET_ENABLED` | No | Explicit `false` | policy | Reset denied |
| `REQUIRE_EXPLICIT_INGESTION_DATA_MODE` | No | Explicit `true` for RC | gate policy | Missing-mode automated/live-safe evidence |
| Rate-limit variables | No | RC policy, not inherited | approved defaults | 429 tests and metadata |
| Document storage variables | Path non-secret | Fresh RC disk | Render disk | startup probe and file lifecycle smoke |
| `OPENAI_API_KEY` | Yes | Absent initially; fresh if later enabled | separate RC OpenAI project | absence/startup after fix; no provider call |
| AI runtime flag/consent version | Mixed | disabled/absent initially | approved AI phase | status reports AI ineffective |
| Sentry/PostHog/GA4 variables | Mixed | absent | privacy posture | bundle/runtime inventory confirms compiled/initialized off |
| `PORT`, Render runtime metadata | No | Platform-supplied | Render | listener and deploy metadata |

Use `NODE_ENV=production` for optimized runtime behavior. Before creation,
choose and document the exact `APP_ENV` label. The current security helpers use
the literal `production` label for the strict CORS/proxy profile and also
recognize `pilot`/`paid-pilot` for durable storage. The safest no-code option is
`APP_ENV=production` while operational metadata and service naming clearly mark
the service as RC; however, that makes `/health` report `production`. Prefer a
small reviewed follow-up that recognizes `rc` as a deployed/fail-closed profile
before real-data go. Until then, all strict CORS, proxy, and durable-storage
values must be set and tested explicitly.

## 11. Frontend RC

A separate frontend RC deployment is required. The frontend compiles
`VITE_API_BASE_URL` into the bundle; the existing Preview frontend points at the
frozen Preview API and must not be reused as the RC origin.

Recommended design:

- branch: `release/phase2-real-data-rc-web`
- base: independently reviewed Phase 2 safeguards frontend SHA (the current
  branch head observed during this preflight is
  `9d3d7a95e6acb4da9df65afe8d39fe26e55795c4`)
- deploy as a separate Vercel project or isolated custom RC environment;
- `VITE_API_BASE_URL=https://carbonlite-phase2-real-data-rc.onrender.com/api`;
- `VITE_APP_VERSION=<exact frontend SHA>`;
- telemetry variables absent;
- no Production alias/domain and no Niall/customer routing;
- backend `FRONTEND_URL` and exact CORS origin set to the resulting stable RC
  origin.

The frontend SHA and branch require their own review before creation. Vercel
Preview deployments can use branch-specific variables; a custom environment is
preferable for a durable RC if the account plan supports it:
<https://vercel.com/docs/deployments/environments>.

## 12. Branch protection

### Must have before any real-data go

- protect `release/phase2-real-data-rc` and its frontend counterpart;
- prohibit force pushes and deletion;
- require the unit, focused E2E, build, lint, and Prisma checks;
- require an approved PR/review for changes after initial branch creation;
- deploy only an exact reviewed SHA with Auto-Deploy OFF;
- prevent direct Production promotion.

### P1 hardening

- signed commits/tags or an equivalent provenance control;
- CODEOWNERS for security/compliance paths;
- environment/deployment approvals in GitHub/Render/Vercel;
- immutable release evidence containing backend/frontend SHA and deployment IDs.

## 13. Controlled deployment procedure

After separate explicit approval:

1. Review the validated no-OpenAI startup correction and its implementation
   report.
2. Push the reviewed backend commits to `phase2/p0-0-real-data-gate`.
3. Create `release/phase2-real-data-rc` from the exact approved commit
   containing this plan; push without force and protect it.
4. Review and create/protect `release/phase2-real-data-rc-web` from the exact
   approved frontend SHA.
5. Create the new Neon project in AWS US East 1 from a clean baseline.
6. Create `carbonlite_rc`, migrator/runtime roles, direct migration URL, and
   pooled runtime URL.
7. Create the new Render service in Virginia with Auto-Deploy OFF and no linked
   legacy environment group.
8. Attach a new RC-only persistent disk.
9. Set non-secret variables, then securely generate and enter fresh RC-only
   database, JWT, and `rc-v1` HMAC secrets.
10. Confirm legacy HMAC keyring, OpenAI, telemetry, Preview URLs, Production
    URLs, and legacy storage are absent.
11. Manually deploy the exact reviewed backend SHA; run all 60 migrations via
    the migrator role.
12. Load and verify the canonical 21-factor manifest using the controlled
    one-run interlock.
13. Verify SHA, health, database identity, migration count, storage health,
    HMAC metadata, and disabled integrations.
14. Create/deploy the isolated frontend RC with only the new backend URL and RC
    origin.
15. Run the minimum synthetic/disposable validation below.
16. Record sanitized release evidence. Do not promote to Production.

No step in this sequence may alter the frozen Preview service.

## 14. Minimum clean-RC validation

### Infrastructure

- exact backend and frontend SHAs;
- Render deployment Live, Auto-Deploy OFF;
- `/api/health/live` and `/api/health/ready` return 200;
- readiness reports database `ok`;
- 60 migrations applied to the expected clean project/branch/database;
- RC-only persistent storage startup health passes;
- canonical factor verification is PASS with 21/21 eligible factors.

### HMAC

- active version `rc-v1`;
- loaded versions exactly `[rc-v1]`;
- `legacy=NO`, `additive=YES`, count 1;
- evidence count initially zero;
- one disposable authorization decision records `rc-v1` and verifies;
- no Preview labels or keys are loaded.

### Isolation

- no Niall/Emerald account, organization, membership, invitation, or token;
- no Production or Preview database host/project/branch;
- no historical Preview evidence;
- no Preview disk/files;
- OpenAI, Sentry, PostHog, and GA4 disabled;
- no Production aliases or domains.

### Minimal non-AI real-data gate smoke

Use one synthetic/disposable organization only:

1. Declared `REAL_CUSTOMER_DATA` before approval is denied with zero record
   side effects.
2. Approve the disposable organization and verify `rc-v1` evidence.
3. Create one supported manual synthetic record while declaring
   `REAL_CUSTOMER_DATA`; verify expected calculation and audit mode.
4. Exercise one minimal local spreadsheet import if needed to prove the
   non-provider path.
5. Withdraw approval; verify future declared real-data processing is denied.
6. Do not test document AI, provider calls, full historical P0-0, or workspace
   erasure during this baseline.

## 15. Creation blockers and approvals

| Requirement | Status | Blocking? |
|---|---|---:|
| Git candidate lineage | Deployment candidate descends directly from `9a3b937...`, which descends directly from `2552b60...` | No |
| Candidate remotely available | Deployment candidate remains local and is not pushed | **Yes** |
| Dedicated RC backend branch | Strategy selected; branch not created/protected | **Yes** |
| OpenAI absent startup | Resolved and validated: startup plus live/ready pass without the key; provider extraction fails closed with 503 | No |
| New Render service | Exact plan defined; not created | **Yes** |
| Clean Neon project/database | New-project strategy selected; not created | **Yes** |
| Database roles | Least-privilege design defined; not created/tested | **Yes** |
| Fresh HMAC signer | Additive-only design defined; key intentionally not generated | **Yes** |
| Fresh JWT secret | Required; intentionally not generated | **Yes** |
| Storage | RC-only disk/path plan defined; not provisioned | **Yes** before upload smoke |
| Region | Virginia/us-east-1 recommended | Approval required; Production residency remains unresolved |
| Frontend RC | Required; branch/project/environment not created | **Yes** for browser smoke |
| Branch protection | Requirements defined; current release protection not established | **Yes** before real-data go |
| Telemetry | Disabled baseline selected | No, once absence is verified |
| OpenAI | Disabled baseline selected; AI-enabled testing deferred | No |
| Deployment procedure | Defined; no action taken | Approval required |

## 16. Explicit mutation boundary

The following future actions each require approval and are not performed by this
plan:

- pushing the reviewed descendant of `9a3b937...`;
- creating/pushing/protecting backend or frontend RC branches;
- creating a Neon project, branch, database, roles, or credentials;
- creating a Render service, disk, environment variables, or deployment;
- generating or entering JWT/HMAC/database secrets;
- creating a Vercel RC project/environment/deployment;
- running migrations, factor loading, or smoke-test mutations;
- creating disposable organizations or authorization evidence.

## 17. Separation confirmations

- Frozen Preview: untouched; never a target or configuration source.
- Production: untouched and not established by this plan.
- Niall/Emerald Sustainability: untouched and excluded from the RC database.
- Existing Neon `main`, `development`, and backup branches: read-only inspected;
  not selected as the RC data source.
- No secrets were read, generated, copied, or recorded.
