# F16 — Exception logging redaction

## Audit of the current implementation

The registered global filter is `GlobalExceptionFilter` in `main.ts`. For HTTP 500+, it logged the request method, full original URL, exception message, body JSON, and stack. HTTP response generation was separate. The other `AllExceptionsFilter` is not registered and does not log.

Its old sensitive-key set was `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, and `authorization`. Only incoming keys were lowercased. Consequently `accessToken` became `accesstoken`, which did not match the mixed-case configured entry. No underscore/hyphen/space normalization was applied. Objects and arrays nested inside the first level were retained unchanged. Top-level strings were also retained unchanged. No depth, array, string, total-size, or cycle bounds existed.

Headers/cookies were not explicitly logged by the filter. Query parameters and concrete route params were included indirectly in the raw URL. The entire body could include activity DTOs, extracted content, report/source payloads, or nested credentials. Arbitrary exception messages/stacks could contain SQL values or upstream provider content. Circular values could break JSON serialization and mask response handling.

Other directly related error paths:

- ActivityData create/list failures dumped DTO/query/database data plus raw messages/stacks. Their “sanitize” helper only converted Prisma decimals; it did not redact credentials or business data.
- Document extraction logged raw provider error messages/stacks and forwarded the original error to Sentry.
- Development admin-activity errors logged raw error messages/stacks.
- Sentry's metadata helper had basic recursive regex redaction and some per-field limits, but no global width/size budget. Raw exception capture and automatic SDK request attachments could still expose data.
- Request-completion logging omitted queries but retained concrete path params, including on failed requests.

F09 optional-event logging already retained only bounded operation/entity/workspace identifiers and omitted mutation payloads and error contents. Optional login-audit logging similarly retained bounded workspace/user IDs. These implementations were left unchanged.

No JWT secret/environment dump was found. Database-startup diagnostics intentionally retain target host/database and a Prisma code, not database credentials. Routine extraction logs still include stored paths and file/model/status metadata; these are a separate privacy consideration rather than raw provider/request dumps.

## Chosen minimal policy

Global exception logs are **metadata-only**: operation, HTTP method, registered route template, status, user/workspace identifiers, and a safe error category. They do not serialize bodies, headers, cookies, query values, concrete path params, arbitrary exception messages, stacks, or provider error objects. Request-completion logs use the registered route template too, preventing that adjacent path from reintroducing concrete URL values.

ActivityData, extraction, and development admin-activity error paths use the same safe error writer. HTTP/provider statuses and a small allowlist of useful connection/Prisma error codes may remain. Unknown code strings, raw messages, raw stacks, request config, response data, and source bytes do not.

Retained diagnostic metadata uses `sanitizeRequestBody`, a small common recursive helper. Both configured keys and incoming keys are normalized by lowercasing and removing underscores, hyphens, and whitespace. Matching is normalized exact matching, not `includes('token')`. The explicit set covers the password family, access/refresh/id/session/CSRF/JWT tokens, authorization/cookies, API/client secrets, repository password-setup token hashes, admin script tokens, OpenAI API keys, database URLs, and named source/OCR/provider payload fields. Harmless fields such as `tokenCount` remain available.

Limits:

- Maximum depth: 5 from root depth zero; deeper content becomes `[TRUNCATED]`.
- Arrays: first 10 sanitized elements, then a truncation marker.
- Objects: first 20 fields, then a truncation marker.
- Traversal: maximum 128 visited values.
- Strings/keys: 256 characters; oversized string values append `[TRUNCATED]`.
- Final sanitized JSON representation: at most 8,192 characters; an oversized result becomes `[TRUNCATED]` rather than a partial serialized object.
- Sensitive values use `[REDACTED]`, without lengths, hashes, or partial token values.

The helper produces a new representation, detects cycles, avoids invoking accessors/toJSON, handles dates and primitives, and replaces uninspectable/non-plain values safely. Sanitizer and logging-sink exceptions are contained. The global filter's public status/message/path/timestamp response contract remains unchanged, including its existing path echo back to the requesting client.

Sentry receives a safe summary Error instead of the raw provider/database exception. A final `beforeSend` allowlist retains event envelope fields and bounded CarbonLite diagnostic context, dropping raw requests, headers, cookies, query URLs, breadcrumbs, extra payloads, original message/stack, and other automatic attachments. Sentry diagnostics therefore trade raw stack/message detail for bounded operation/category/status/identifier context. This is deliberate to prevent sensitive contents from leaving through a second exception output channel. Expected-error filtering and duplicate capture marking retain their existing behavior.

## Validation

Tests verify final serialized logger/transport arguments, not only intermediate objects:

| Regression | Result |
| --- | --- |
| Top-level passwords and password-family variants | PASS |
| camelCase, snake_case, kebab-case and case/space variants | PASS |
| Nested objects and mixed nested arrays | PASS |
| Authorization, cookies/session, client/API secrets | PASS |
| Safe business metadata and exact-key matching | PASS |
| Large source strings/arrays, object width and total bound | PASS |
| 10,000-level nesting and circular values | PASS |
| Primitives, valid/invalid dates, getters/toJSON/proxies | PASS |
| Original request/metadata objects unchanged | PASS |
| Actual Nest HTTP 500/503 responses with nested secrets | PASS |
| HTTP response survives logging sink failure | PASS |
| Extraction provider error with auth/config/base64/response contents | PASS |
| Sentry capture and final automatic-attachment boundary | PASS |
| Auth, JWT, permission, F08 and import regression coverage | PASS |
| F09 optional-event and workflow-audit regressions | PASS |

**188 tests in 16 suites passed:** 45 sanitizer/filter/Sentry transport unit tests; 1 extraction logging test; 9 actual HTTP and targeted Sentry tests; 133 auth/JWT/permission/F09/F08/import/activity-data regressions.

Backend typecheck (`tsc --noEmit -p tsconfig.json`) and Nest production build passed. No database or external provider was contacted. Real HTTP integration tests used ephemeral local listeners; auth/provider/database dependencies in the selected regressions were mocked. Database-backed end-to-end suites were not run. The unrelated pre-existing electricity factor-ID assertion was not encountered or changed.

Validation was performed on an isolated `/tmp/carbonlite-f16` source copy because the backend repository lies outside the frontend workspace's writable roots. A reviewed patch and hash manifest guard applying only the listed files, preserving pre-existing working-tree changes. The installed Node 20 executable was used because the backend bin wrapper selected a broken Homebrew Node/ICU installation.

## Files

Production: `src/common/logging/safe-log.ts`, `src/common/logging/sentry-event.ts`, `src/common/filters/global-exception.filter.ts`, `src/common/monitoring/capture-app-error.ts`, `src/activity-data/activity-data.service.ts`, `src/activity-tracking/activity-tracking.service.ts`, `src/document-extraction/document-extraction.service.ts`, `src/main.ts`, `src/sentry.ts`.

Tests: `src/common/logging/safe-log.spec.ts`, `src/common/logging/sentry-event.spec.ts`, `src/common/filters/global-exception.filter.spec.ts`, `src/document-extraction/document-extraction.logging.spec.ts`, `test/logging-redaction.e2e-spec.ts`, and the updated marker/provider assertions in `test/targeted-sentry.e2e-spec.ts`.

Frontend/schema/migrations/dependencies: unchanged. Auth/JWT, upload/extraction limits and outcomes, calculations/import identity, and F01–F15 business behavior: unchanged. Only their diagnostic log representations are affected.

## Remaining logging/privacy limits

Explicitly retained diagnostic strings can contain limited personal/business information; this is not a universal PII classifier. Unknown future secret aliases require extending the exact-key list. Do not use this metadata helper to justify adding arbitrary request/provider bodies to logs. Routine stored filenames/paths, audit-history persistence, database target names, infrastructure/proxy access logs, and previously recorded log retention remain outside this exception-logging patch. No live Sentry transmission was performed. In-memory serialization/SDK-boundary assertions provide the verification evidence.

F16 only. No observability framework, authentication semantics, retention policy, frontend, schema, or unrelated hardening changes.
