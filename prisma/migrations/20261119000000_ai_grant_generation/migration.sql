BEGIN;
-- Zero is deliberately unknown: existing grants require explicit reissuance.
ALTER TABLE "OrganizationAiAuthorization"
  ADD COLUMN "grantGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "OrganizationAiAuthorization_grantGeneration_nonnegative"
    CHECK ("grantGeneration" >= 0);

-- Keep the counter for the lifetime of its organization. Organization erasure
-- may cascade; standalone deletion, truncation, reassignment and rewind may not.
CREATE FUNCTION "carbonlite_guard_ai_grant_generation"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'AI grant generations cannot be truncated' USING ERRCODE = '23514';
  ELSIF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public."Organization" WHERE "id" = OLD."organizationId") THEN
      RAISE EXCEPTION 'AI grant generation cannot be reset' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  ELSIF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."grantGeneration" < OLD."grantGeneration" THEN
    RAISE EXCEPTION 'AI grant generation cannot be reassigned or decreased' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrganizationAiAuthorization_generation_guard"
  BEFORE UPDATE OR DELETE ON "OrganizationAiAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "carbonlite_guard_ai_grant_generation"();
CREATE TRIGGER "OrganizationAiAuthorization_generation_truncate_guard"
  BEFORE TRUNCATE ON "OrganizationAiAuthorization"
  FOR EACH STATEMENT EXECUTE FUNCTION "carbonlite_guard_ai_grant_generation"();

COMMIT;
