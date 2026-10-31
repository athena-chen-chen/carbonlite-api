# Paid-pilot backup and recovery

This runbook covers complete PostgreSQL and durable document-source recovery. A partial database restore is unsupported: restore one complete, internally consistent database backup and its matching document-storage backup.

## Backup

Stop writes or place the service in maintenance mode before a manual recovery-point backup. Use PostgreSQL client tools matching the server major version and retain a custom-format dump in encrypted, access-controlled storage outside the application host:

```sh
pg_dump --format=custom --file=carbonlite.dump "$DATABASE_URL"
```

Back up the complete `DOCUMENT_STORAGE_PATH` tree while preserving relative storage keys. For a mounted filesystem, an archive plus a separate checksum manifest is sufficient when the infrastructure provider does not supply volume snapshots:

```sh
tar -czf carbonlite-document-storage.tar.gz -C "$DOCUMENT_STORAGE_PATH" .
find "$DOCUMENT_STORAGE_PATH" -type f -exec shasum -a 256 {} \;
```

Record each relative storage key, byte size, and SHA-256 checksum. Retain the database dump, storage archive, checksum manifest, backup timestamp, application release, and PostgreSQL version together under the same recovery-point identifier. Never place credentials in backup logs or manifests.

## Restore

1. Stop customer writes or enable maintenance mode.
2. Create a fresh PostgreSQL database and restore the complete dump with matching PostgreSQL tools:

   ```sh
   createdb "$RESTORE_DATABASE_NAME"
   pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" carbonlite.dump
   ```

3. Restore the full document archive into a fresh durable directory, preserving every relative key:

   ```sh
   mkdir -p "$RESTORE_DOCUMENT_STORAGE_PATH"
   tar -xzf carbonlite-document-storage.tar.gz -C "$RESTORE_DOCUMENT_STORAGE_PATH"
   ```

4. Recompute file sizes and SHA-256 checksums and compare every entry with the backup manifest. Missing, additional, or mismatched files fail recovery verification.
5. Point `DATABASE_URL` and `DOCUMENT_STORAGE_PATH` at the restored resources. In a deployed runtime, keep `DOCUMENT_STORAGE_DURABLE=true`.
6. Run `npx prisma migrate deploy`. Review the output and stop on any error.
7. Run `npm run factors:verify:production`. Require `PRODUCTION FACTOR GATE: PASS`; do not load factors unless verification proves they are genuinely absent.
8. Start the API and require `/api/health/ready` to pass. Startup also performs the document-storage write/read/delete health check.
9. With a synthetic customer account, verify login, organization profile, Data Records, dashboard totals, reports, authenticated source download, and extraction retry. Confirm totals and historical calculation snapshots against the pre-backup evidence.
10. Resume customer access only after database, storage, integrity, tenant-isolation, and workflow checks pass.

If a database document row points to a missing source file, the API should return the controlled missing-source response; do not remove or recalculate the associated historical emissions record. Restore the object from the matching storage backup. A checksum mismatch is corruption and must never be accepted as valid evidence.

## Provider controls

The repository mentions Neon as an intended shared PostgreSQL provider but contains no production plan/configuration proving automated backups, retention, restore testing, or point-in-time recovery. Production database backup/PITR capability: **REQUIRES OPERATOR/PROVIDER VERIFICATION**.

The current document adapter targets a durable mounted filesystem, but the repository contains no production volume/object-storage provider configuration proving snapshots, replication, retention, or restore support. Production document-storage backup capability: **REQUIRES OPERATOR/PROVIDER VERIFICATION**.
