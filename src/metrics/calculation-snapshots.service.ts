import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationQualityService } from './calculation-quality.service';
import { scopeForActivity } from './calculation-snapshot';

const derivedKeys = ['matchingStatus','reportTreatment','scope','matchedFactorId','matchedFactorName','matchedFactorSourceYear','matchedFactorValue','matchedFactorUnit','matchedFactorVersion','matchedFactorSourceAuthority','matchedFactorSourceDocument','matchedFactorVerificationStatus','matchedFactorConfidenceLevel','matchedFactorAssumptions','factorSelectionReason','factorSelectionExplanation','calculatedEmissionsKgCO2e','calculationStatus','calculationMessage','calculationSnapshot','calculationVersion','calculatedAt'];
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
@Injectable()
export class CalculationSnapshotsService {
  constructor(private readonly prisma: PrismaService, private readonly quality: CalculationQualityService) {}

  async prepareCreate(client: Prisma.TransactionClient | PrismaService, input: any, actorUserId?: string) {
    const row = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? new Date(), updatedAt: new Date() };
    for (const key of derivedKeys) delete row[key];
    return { ...row, ...await this.fields(client, row, actorUserId, 1) };
  }

  async fields(client: Prisma.TransactionClient | PrismaService, row: any, actorUserId: string | undefined, version: number) {
    if (!Number.isFinite(Number(row.quantity)) || Number(row.quantity) <= 0) throw new BadRequestException('Quantity must be a positive number.');
    if (['BUSINESS_TRAVEL','FREIGHT'].includes(row.activityType)) throw new BadRequestException('This legacy activity type is not supported for new calculations.');
    const [organization, factors, governedFactors, facility] = await Promise.all([
      client.organization.findUniqueOrThrow({ where: { id: row.organizationId } }),
      client.conversionFactor.findMany({ where: { type: 'EMISSION', OR: [{ organizationId: row.organizationId }, { isSystemDefault: true }] }, orderBy: [{ isSystemDefault: 'asc' }, { verified: 'desc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }] }),
      client.factorVersion.findMany({ where: { factor: { isActive: true }, status: { notIn: ['DEPRECATED','ARCHIVED'] } }, include: { factor: true, source: true } }),
      row.facilityId ? client.facility.findFirst({ where: { id: row.facilityId, organizationId: row.organizationId } }) : null,
    ]);
    const detail: any = this.quality.evaluate({ organization, records: [{ ...row, recordDate: new Date(row.recordDate), document: null, facility }], factors, governedFactors, recalculate: true }).calculationDetails[0];
    const calculated = detail.status === 'CALCULATED';
    const fields: any = {
      matchingStatus: calculated ? 'MATCHED' : detail.status, calculationStatus: detail.status,
      reportTreatment: calculated ? 'INCLUDED' : detail.status === 'TRACKED_ONLY' ? 'TRACKED_ONLY' : 'REQUIRES_REVIEW',
      scope: scopeForActivity(row.activityType), matchedFactorId: detail.factorVersionId ?? detail.factorId,
      matchedFactorName: detail.factorName, matchedFactorSourceYear: detail.sourceYear,
      matchedFactorValue: detail.factorValue, matchedFactorUnit: detail.factorValue == null ? null : `${detail.factorResultUnit}/${detail.factorInputUnit}`,
      matchedFactorVersion: detail.factorProvenance?.sourceVersion ?? null,
      matchedFactorSourceAuthority: detail.sourceAuthority, matchedFactorSourceDocument: detail.sourceDocument,
      matchedFactorVerificationStatus: detail.factorVerificationStatus, matchedFactorConfidenceLevel: detail.factorConfidenceLevel,
      matchedFactorAssumptions: detail.factorSelectionExplanation, factorSelectionReason: detail.factorSelectionReason,
      factorSelectionExplanation: detail.factorSelectionExplanation, calculatedEmissionsKgCO2e: detail.calculatedEmissionsKgCO2e,
      calculationMessage: detail.reason ?? detail.matchingMessage, calculationSnapshot: Prisma.DbNull, calculationVersion: version,
      calculatedAt: null,
    };
    if (calculated) {
      const calculatedAt = new Date();
      detail.scope = fields.scope;
      const snapshot = { contractVersion: 1, version, calculatedAt: calculatedAt.toISOString(), actorUserId: actorUserId ?? null,
        input: { activityType: row.activityType, quantity: Number(row.quantity), unit: row.unit, recordDate: new Date(row.recordDate).toISOString(), country: row.jurisdictionCountry ?? null, region: row.jurisdictionRegion ?? null },
        factor: { id: detail.factorId, versionId: detail.factorVersionId, value: detail.factorValue, unit: detail.factorInputUnit, resultUnit: detail.factorResultUnit, provenance: detail.factorProvenance },
        conversion: { inputQuantity: Number(row.quantity), inputUnit: row.unit, calculationQuantity: detail.calculationQuantity ?? Number(row.quantity), factorInputUnit: detail.factorInputUnit },
        result: { value: detail.calculatedEmissionsKgCO2e, unit: 'kgCO2e', scope: fields.scope }, detail };
      fields.calculationSnapshot = json(snapshot);
      fields.calculatedAt = calculatedAt;
    }
    return fields;
  }

  async recalculate(client: Prisma.TransactionClient, row: any, actorUserId?: string) {
    const fields = await this.fields(client, row, actorUserId, (row.calculationVersion ?? 0) + 1);
    // Legacy metrics may be the only historical calculation evidence. Archive
    // them before invalidating the current projection, just as we retain snapshots.
    const previousMetrics = row.calculationSnapshot ? [] : await client.metricResult.findMany({
      where: { organizationId: row.organizationId, activityDataId: row.id, metricType: 'CARBON_EMISSION' },
    });
    const previousCalculation = row.calculationSnapshot ?? { activityData: row, metricResults: previousMetrics };
    const updated = await client.activityData.update({ where: { id: row.id, organizationId: row.organizationId, calculationVersion: row.calculationVersion ?? 0 }, data: fields });
    // This shares the caller's transaction with the state/snapshot transition.
    // Explicit metric calculation recreates a projection only for a valid result.
    await client.metricResult.deleteMany({ where: {
      organizationId: row.organizationId, activityDataId: row.id, metricType: 'CARBON_EMISSION',
    } });
    await client.auditLog.create({ data: { organizationId: row.organizationId, userId: actorUserId ?? null,
      action: 'RECALCULATE_ACTIVITY_RECORD', entityType: 'ActivityData', entityId: row.id,
      description: 'Explicit activity calculation; previous result retained in audit history.',
      oldValue: json(previousCalculation), newValue: json({ calculationSnapshot: updated.calculationSnapshot, status: updated.calculationStatus }) } });
    await client.userActivityEvent.create({ data: { organizationId: row.organizationId, userId: actorUserId ?? null,
      eventName: 'ACTIVITY_RECORD_RECALCULATED', entityType: 'ActivityData', entityId: row.id,
      metadata: { previousVersion: row.calculationVersion ?? 0, version: updated.calculationVersion } } });
    return updated;
  }
}
