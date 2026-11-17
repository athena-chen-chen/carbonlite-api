# First platform-admin bootstrap v0.1

## Purpose

CarbonLite requires a persisted platform administrator for customer
provisioning and authorization safeguards. A newly migrated environment may
contain no users, so this repository provides a narrowly scoped operator CLI
for creating the first platform administrator exactly once.

Command:

```text
pnpm admin:bootstrap-platform -- \
  --email <synthetic-admin-email> \
  --name <synthetic-admin-name> \
  --anchor-organization-id <existing-infrastructure-organization-id> \
  --confirm-environment <exact-environment-name> \
  --setup-base-url <trusted-setup-frontend-origin>
```

The command is never invoked during normal application startup and does not
expose an HTTP bootstrap route.

## Threat model and guards

The operator already has privileged shell and database connectivity. The CLI
reduces accidental or remote use through independent fail-closed controls:

1. `ALLOW_PLATFORM_ADMIN_BOOTSTRAP` must be exactly `true`.
2. `PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT` must be non-empty and exactly match
   `--confirm-environment`.
3. The existing platform-admin count must be zero immediately before creation
   inside a serializable transaction.
4. The normalized target email must not already exist in any role. Existing
   users are never promoted.
5. The explicitly supplied anchor organization must already exist, be active,
   and not be suspended.

`NODE_ENV` alone is not an environment confirmation signal.

## Existing-schema anchor

The current `User` schema requires `organizationId`. The bootstrap therefore
anchors the platform administrator to an explicitly confirmed existing
infrastructure organization. It does not create an organization and does not
create a membership. The account is marked `PLATFORM_ADMIN`, and platform
authority comes from the persisted `ADMIN` platform role rather than a
customer membership.

## Setup credential

The CLI reuses the same credential generator, SHA-256 token hashing, 48-hour
expiry, unused-state fields, password-setup endpoint, and normal login/JWT path
as the existing invitation flow. Plaintext is not stored in the database.

On success the CLI emits the one-time setup URL once to the interactive
operator. That output is credential material: do not redirect it to routine
logs, paste it into chat, include it in screenshots, or store it in Markdown or
source control. Browser/model automation must not capture it during the real
RC execution.

No JWT is fabricated. The human completes password setup and then logs in
normally.

## Transaction and audit

User creation, setup state, and audit creation occur in one serializable
transaction. Audit action `PLATFORM_ADMIN_BOOTSTRAPPED` records only the user
ID, resulting role/account type, confirmed environment, and setup expiry. It
never records the token, setup URL, password, JWT, database URL, or bootstrap
control values.

If audit creation fails, the user and setup state roll back. A second execution
fails with `PLATFORM_ADMIN_ALREADY_EXISTS` and creates nothing.

## Failure behavior

- `PLATFORM_ADMIN_BOOTSTRAP_DISABLED`
- `PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT_MISMATCH`
- `PLATFORM_ADMIN_ALREADY_EXISTS`
- `BOOTSTRAP_TARGET_ALREADY_EXISTS`
- `BOOTSTRAP_ANCHOR_ORGANIZATION_INVALID`
- `PLATFORM_ADMIN_BOOTSTRAP_EMAIL_INVALID`
- `PLATFORM_ADMIN_BOOTSTRAP_NAME_REQUIRED`
- `PLATFORM_ADMIN_BOOTSTRAP_ARGUMENTS_INVALID`
- `PLATFORM_ADMIN_BOOTSTRAP_SETUP_URL_INVALID`

Failures emit only stable codes and never echo credentials or database targets.

## One-time RC procedure

1. Verify the RC SHA, database boundary, migrations, and zero-admin count.
2. Select the existing synthetic infrastructure anchor organization.
3. Prepare a synthetic `.invalid` administrator identity.
4. Set `ALLOW_PLATFORM_ADMIN_BOOTSTRAP=true` only in the trusted operator
   process.
5. Set `PLATFORM_ADMIN_BOOTSTRAP_ENVIRONMENT` to the exact RC environment name.
6. Run the CLI once with the matching confirmation and trusted setup origin.
7. Deliver the one-time setup URL directly to the human operator without
   browser/model capture.
8. Complete normal password setup and normal login.
9. Verify the authenticated account is a platform admin with no membership.
10. Remove/disable the bootstrap permission.
11. Re-run preflight and confirm a second bootstrap is refused because an admin
    already exists.

The command creates no customer organization, membership, invitation,
real-data authorization, AI authorization, or HMAC evidence.

## Production warning

This mechanism does **not** mean Production should routinely bootstrap admins.
Production first-admin governance, operator identity verification, dual control,
credential delivery, and evidence retention remain a separate security and
operational decision. Never copy an RC administrator or setup credential into
Production.
