-- CreateIndex
CREATE INDEX "ActivityData_organizationId_recordDate_idx" ON "ActivityData"("organizationId", "recordDate");

-- CreateIndex
CREATE INDEX "ActivityData_organizationId_facilityId_recordDate_idx" ON "ActivityData"("organizationId", "facilityId", "recordDate");

-- CreateIndex
CREATE INDEX "ActivityData_organizationId_activityType_recordDate_idx" ON "ActivityData"("organizationId", "activityType", "recordDate");

-- CreateIndex
CREATE INDEX "ActivityData_organizationId_sourceDocumentId_idx" ON "ActivityData"("organizationId", "sourceDocumentId");

-- CreateIndex
CREATE INDEX "Factor_activityType_isActive_idx" ON "Factor"("activityType", "isActive");

-- CreateIndex
CREATE INDEX "FactorVersion_factorId_inputUnit_jurisdictionCountry_jurisd_idx" ON "FactorVersion"("factorId", "inputUnit", "jurisdictionCountry", "jurisdictionRegion", "factorYear");

-- CreateIndex
CREATE INDEX "FactorVersion_status_factorYear_idx" ON "FactorVersion"("status", "factorYear");

-- CreateIndex
CREATE INDEX "ConversionFactor_type_activityType_organizationId_idx" ON "ConversionFactor"("type", "activityType", "organizationId");

-- CreateIndex
CREATE INDEX "ConversionFactor_type_activityType_isSystemDefault_idx" ON "ConversionFactor"("type", "activityType", "isSystemDefault");

-- CreateIndex
CREATE INDEX "ConversionFactor_activityType_unit_country_region_sourceYea_idx" ON "ConversionFactor"("activityType", "unit", "country", "region", "sourceYear");

-- CreateIndex
CREATE INDEX "ConversionFactor_activityType_unit_country_jurisdiction_sou_idx" ON "ConversionFactor"("activityType", "unit", "country", "jurisdiction", "sourceYear");

-- CreateIndex
CREATE INDEX "Report_organizationId_reportingYear_idx" ON "Report"("organizationId", "reportingYear");

-- CreateIndex
CREATE INDEX "Report_organizationId_periodStart_periodEnd_idx" ON "Report"("organizationId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Report_organizationId_status_createdAt_idx" ON "Report"("organizationId", "status", "createdAt");
