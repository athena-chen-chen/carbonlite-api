# Document source-evidence storage

CarbonLite stores uploaded evidence through `DocumentStorage`. The current adapter is a
filesystem adapter suitable for local development or a durable mounted filesystem.

## Configuration

- Local development defaults to `./uploads`.
- `DOCUMENT_STORAGE_PATH` selects another filesystem root.
- Production and paid-pilot runtimes require both an explicit
  `DOCUMENT_STORAGE_PATH` and `DOCUMENT_STORAGE_DURABLE=true`. Startup fails if either
  is absent or if a safe write/read/delete health check fails.
- `DOCUMENT_UPLOAD_TEMP_PATH` may select multipart staging. Staged files are deleted
  after validation and are not durable source evidence.

## Existing files

Existing database values such as `/uploads/<name>` remain valid storage identifiers.
No files are moved or deleted automatically. Before changing a deployed storage root,
an operator must copy the existing `uploads` contents into the new durable root while
preserving relative names, verify counts and hashes, then set the environment variables
and restart. Keep the old copy until authenticated download and extraction-retry checks
have succeeded for representative documents.

Object storage can be added as another `DocumentStorage` adapter without changing the
document, download, deletion, or extraction workflows.
