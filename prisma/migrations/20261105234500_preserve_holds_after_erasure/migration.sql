-- Hold state must remain able to protect quarantined bytes after the customer
-- organization row has been erased. Application authorization and advisory
-- locks continue to enforce the organization identifier boundary.
ALTER TABLE "LegalHold"
  DROP CONSTRAINT "LegalHold_organizationId_fkey";
