# Workspace data erasure

`Organization` is CarbonLite's customer workspace boundary. The paid-pilot operator
workflow is an authenticated platform-admin API rather than a frontend control or an
unauthenticated maintenance route:

- `POST /api/admin/workspace-erasure/dry-run`
- `POST /api/admin/workspace-erasure/erase`

The destructive command requires the target organization ID twice, its exact slug,
and `confirmErase: true`. Platform administrators cannot erase their active workspace.

## Inventory and ownership

The shared inventory covers organization users and memberships, facilities and assets,
documents and physical evidence, document extractions, spreadsheet review rows,
activity records and embedded calculation snapshots, import-batch references, metric
results, reports and report-artifact references, AI jobs, organization-owned conversion
factors, audit logs, feedback, and activity events. Fuel activity and calculation
evidence live in ActivityData/MetricResult rather than separate active tables.

Global Factor, FactorVersion, and FactorSource records are not organization-owned and
are never deleted. Factor governance logs retain their global evidence while user
foreign keys are cleared by the existing relation policy.

## Ordering and retry

1. Authorize the platform operator and validate exact confirmations.
2. Build the same inventory used by dry run.
3. Delete managed source objects through `DocumentStorage`. Already-missing objects are
   successful idempotent outcomes. Any other storage failure stops before DB deletion.
4. Delete the Organization inside one DB transaction. Existing cascades remove owned
   children. A DB failure leaves already-removed objects missing; retry safely accepts
   that state and repeats the transaction.

Report artifacts using managed `/uploads/` keys join the storage deletion plan. A
non-empty external `generatedPdfUrl` has no configured artifact-storage adapter, so the
workflow fails closed instead of claiming complete erasure.

Minimal operational audits are stored outside the erased organization. They retain a
SHA-256 organization-ID hash, actor ID, timestamps, status, and counts only—never the
workspace name/slug, uploaded content, activity payloads, or emissions data.
