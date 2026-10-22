# F21: document confirmation nested validation and lineage contract

## Result

F21 is fixed without service, calculation, factor, transaction, identity, schema, migration, frontend, or global ValidationPipe changes. Every activity is now an object validated through ParsedActivityDto. Malformed requests fail before confirmImport; canonically blocked but structurally valid rows retain F12 partial-import behavior.

## Before implementation: audited current contract

- Top-level ConfirmExtractionDto: documentId @IsString; activities @IsArray only; optional string importBatchId. No nested validation or collection cap.
- Nested ParsedActivityDto existed but was never traversed. Required string activityType/recordDate/unit and numeric quantity; optional strings periodRole, usageType, comparisonType, jurisdictionCountry, jurisdictionRegion, facility, facilityName, sourceDocumentId, sourceFileName, sourceSheetName, importBatchId; costCad used @Type(Number)/@IsNumber; costCurrency optional string with MaxLength(12). sourceReference and notes had @IsString without @IsOptional despite optional TypeScript declarations.
- main.ts and the E2E helper both use ValidationPipe({whitelist:true, forbidNonWhitelisted:true}). transform defaults false, enableImplicitConversion is not enabled, stopAtFirstError is not enabled. ValidationPipe still transforms internally for validation; @Type is necessary for nested class metadata. Options remain unchanged.
- A probe using those exact options accepted [null], ["abc"], [123], [true], [[]], and [{}]. No dedicated malformed-confirmation boundary tests existed. null could subsequently crash normalization; primitive/empty rows otherwise depended on service errors. Nested unknown fields previously escaped whitelist enforcement.
- Frontend buildDocumentImportActivityPayload supplies canonical activityType, recordDate, recordYear, numeric quantity, unit, country/region, facility, sourceType, sourceReference, documentId, sourceDocumentId, sourceFileName, sourceSheetName, sourcePage, sourceRow, sourceTextSnippet, costCad/costCurrency, importBatchId, dateEstimated, notes, and calculation hints. confirmDocumentImport removes matchedFactorSourceUrl before POST. No frontend change is needed.
- confirmImport consumes activities:any[]. normalizeActivityForImport reads activityType, recordDate, quantity, unit, periodRole, usageType, comparisonType, jurisdictionCountry, jurisdictionRegion, facility/facilityName, sourceReference, notes, sourceRow, sourcePage, sourceTextSnippet, sourceFileName, sourceSheetName, costCad, costCurrency, importBatchId, recordYear, and all calculation hints listed below. Its alias readers also accept human spreadsheet headings (Activity Type, Record Date, Quantity, Unit, Country, Province, Source Row, etc.) for internal normalization. This does not establish every internal alias as a public HTTP property.
- prepareCreate accepts any input; the confirmation call supplies organizationId/documentId, activityType, Date recordDate, jurisdictionCountry/Region, facilityName, recordYear, quantity, unit, sourceType, sourceReference, sourceDocumentId, sourceFileName, sourceSheetName, sourceRow, sourcePage, sourceTextSnippet, costCad/costCurrency, top-level stable importBatchId, notes and derived hints. It adds id/createdAt/updatedAt, deletes derived keys, and merges canonical fields.
- Derived hints read by the service: matchingStatus, reportTreatment, scope, matchedFactorId, matchedFactorName, matchedFactorSourceYear, matchedFactorValue, matchedFactorUnit, matchedFactorVersion, matchedFactorSourceAuthority, matchedFactorSourceDocument, matchedFactorVerificationStatus, matchedFactorConfidenceLevel, matchedFactorAssumptions, factorSelectionReason, factorSelectionExplanation, calculatedEmissionsKgCO2e, calculationStatus, calculationMessage. These remain optional, structurally typed and untrusted. prepareCreate strips and recomputes them. Snapshot/version/timestamp fields are not accepted from this HTTP contract.
- Staged confirmation uses the selected rows to update tenant-scoped persisted review rows, evaluates canonical fields, and imports staged rows. Its source file/sheet/row/reference come from staging. Empty activities intentionally selects persisted staged rows.
- Unstaged confirmation normalizes canonical request rows directly. Source file/sheet/row/page/reference/snippet are forwarded. documentId/sourceDocumentId/sourceType and effective batch are set by the server; per-row documentId/sourceDocumentId/sourceType/importBatchId are compatibility hints, never ownership authority.
- Real XLSX extraction produces confidence-wrapped core fields, one-based physical sourceRow (first data row normally 2), sheet/file names and raw parser fields. The browser unwraps/normalizes these into its explicit confirmation payload. Raw parser fields and confidence wrappers are not confirmation inputs.
- Existing stored rows/pages are text; browser types accept number|string|null. Row digit strings and integer values must preserve their representation until existing normalization. Page labels/ranges are already representable and remain accepted; no page numbering conversion is introduced.
- quantity is a browser number; numeric quantity strings are not the established typed public contract. costCad explicitly supports numeric strings. Dates are strings, usually YYYY-MM-DD, with service validity based on JavaScript Date parsing. No ISO-only or calendar interpretation change is made.
- Facility name/string is supported; facilityId is not consumed by this confirmation call. Country/region are optional strings. No required province, activity enum, factor, scope or unit compatibility decorator is appropriate.
- F08 bounds extracted review rows at 10,000 and physical spreadsheet rows at 10,000 including headers. Confirmation previously had no row cap. The existing Express JSON byte limit can reject large payloads sooner; this task does not change transport limits.

This audit was reported before implementation. The smallest safe contract is four required core fields, optional supported input/lineage fields and current browser hints, nested object validation, and the existing review-row cap.

## Implemented contract

activities uses @IsArray, @ArrayMaxSize(MAX_EXTRACTED_REVIEW_ROWS), @IsObject({each:true}), @ValidateNested({each:true}), and @Type(() => ParsedActivityDto). IsObject additionally prevents arrays of arrays from passing recursive nested traversal. Every malformed element rejects the entire request before service execution.

Required fields are activityType:string, recordDate:parseable string, quantity:finite number, unit:string. Dates retain the existing service Date.parse semantics, including date-only and timestamp representations. Domain restrictions remain in the service and evaluator.

Optional text fields now include sourceReference and notes. Added lineage declarations are sourceRow, sourcePage, sourceTextSnippet. sourceRow accepts a non-negative safe integer or digit string, with no coercion or row offset. sourcePage accepts a non-negative safe integer or non-empty text label/range, matching its existing text persistence. Optional null values retain the existing IsOptional behavior.

Other supported lineage fields: sourceFileName, sourceSheetName, sourceReference, sourceDocumentId, sourceType, importBatchId. sourceDocumentId/sourceType are accepted only as frontend compatibility fields; server-owned values are used. Top-level importBatchId continues to control the stable batch. Unknown fields are rejected with 400 under the unchanged whitelist policy.

The DTO also declares frontend documentId/dateEstimated/recordYear and all consumed calculation hints with structural validators, so nested whitelist enforcement does not break working browser payloads. Fields such as dateEstimated that the confirmation service does not persist remain ignored. Numeric cost strings are converted locally; booleans/objects/empty strings are not converted into numbers. No implicit quantity conversion is added.

Collection maximum: 10,000, shared with F08 MAX_EXTRACTED_REVIEW_ROWS. Empty arrays remain valid for staged confirmation. The limit does not promise a 10,000-row transaction will fit HTTP byte or transaction timeout limits.

## Verification

All database-backed verification passed through assertSafeTestDatabaseTarget before application/Prisma startup. Target was loopback localhost:5432/carbonlite_ci_test. No hosted or development database was used. The corrected seven-factor deterministic fixture was preserved; no factor seeding or schema change was made for F21.

| Check | Result |
| --- | --- |
| Focused DTO validation | 57/57 PASS |
| HTTP collection boundary with mocked service and no DB | 1/1 PASS; 10,000 reaches service, 10,001 returns 400 without service call |
| Actual API malformed requests and lineage | 16/16 PASS |
| null/string/number/boolean/nested array/empty object | 400 before service |
| mixed valid + null | 400, service not called, zero writes |
| wrong field types and unknown property | 400 before service |
| complete source lineage | PASS through service into ActivityData |
| SheetA row 2 + SheetB row 2 | two distinct rows; retry creates zero |
| forged identity/source/batch/calculation hints | server values retained; calculated 808.50 rather than 999999 |
| Existing eligibility/lineage unit regressions | 28/28 PASS |
| F20 test database safety | 33/33 PASS |
| F12 eligibility | 20/20 PASS, including staged/unstaged parity |
| missing province | DTO PASS, canonical block |
| Diesel 240 kg / unsupported activity | DTO PASS, canonical block |
| tracked Water 18 m3 | imported tracked-only, zero GHG |
| empty staged confirmation | existing intended behavior preserved |
| partial confirm | 3 -> 1 -> 0 PASS |
| F05 concurrency | 14/14 PASS |
| real workbook Field Mapping | 5/5 PASS; Gasoline 350 L = 808.50 |
| Golden A / C / combined | 579.40 / 2428.44 / 3007.84 PASS |
| backend typecheck / Nest build | PASS / PASS |

Malformed HTTP tests use the real controller, application pipe and F16 global filter. They assert confirmImport is not called and compare document/activity/staging/extraction/audit/event/metric state before and after. Responses contain validation messages without stacks, Prisma details or DTO class names.

For {}, validation reports activities.0.activityType must be a string; activities.0.recordDate must be a string and must be a valid date string; activities.0.quantity must be a number conforming to the specified constraints; activities.0.unit must be a string.

The maximum HTTP test raises only its isolated, DB-free test parser byte limit to exercise the row cap; production parser settings are unchanged. The real XLSX replay bundles and executes the existing frontend buildDocumentImportActivityPayload and applies the existing source-URL omission before HTTP confirmation, rather than sending raw extraction objects.

Typecheck and build use Node v20.19.5 explicitly because the host default Node executable has an unrelated ICU linkage problem. The initial sandboxed database run could not reach local PostgreSQL; the same guarded tests passed with local-network permission. The rollback concurrency test intentionally emits its synthetic failure while passing its rollback assertions.

## Files and boundaries

Changed backend files:

- src/document-extraction/dto/confirm-extraction.dto.ts
- src/document-extraction/dto/confirm-extraction.dto.spec.ts
- src/document-extraction/document-confirm-boundary.spec.ts
- test/document-confirm-validation.e2e-spec.ts
- docs/audits/f21-document-confirmation-dto.md

Frontend changed: NO. Schema changed: NO. Migration added: NO. Calculation logic changed: NO. Factor matching changed: NO. Import identity/locking changed: NO. Existing F01-F20 implementations changed: NO. The unrelated electricity factor-ID assertion was not encountered or modified.

Remaining contract limits: JavaScript parseable-date semantics (including calendar normalization) remain for F22; page labels remain text; optional null behavior is unchanged; the transport byte limit can apply before the row cap; internal spreadsheet aliases/raw extraction fields and unused frontend type-only fields are not automatically public confirmation properties. Structurally valid business-invalid values remain subject to existing service validation and canonical evaluation. This change does not bound the empty-array staged workload separately, alter transaction timeouts, or introduce a new generic validation framework.
