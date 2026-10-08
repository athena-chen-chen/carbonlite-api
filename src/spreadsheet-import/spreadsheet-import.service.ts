import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  SpreadsheetImportSourceType,
  SpreadsheetReviewRowStatus,
} from '@prisma/client';
import { parseDateOnlyUtc } from '../common/date-only';
import { PrismaService } from '../prisma/prisma.service';
import {
  SaveSpreadsheetReviewRowsDto,
  SpreadsheetReviewRowDto,
} from './dto/save-spreadsheet-review-rows.dto';
import { SpreadsheetReviewRowQueryDto } from './dto/spreadsheet-review-row-query.dto';

@Injectable()
export class SpreadsheetImportService {
  constructor(private readonly prisma: PrismaService) {}

  async findReviewRows(
    organizationId: string,
    query: SpreadsheetReviewRowQueryDto = {},
  ) {
    const sourceDocumentIds = parseCsvList(query.sourceDocumentIds);

    if (sourceDocumentIds.length === 0) {
      return { items: [] };
    }

    const rows = await this.prisma.spreadsheetImportReviewRow.findMany({
      where: {
        organizationId,
        sourceDocumentId: { in: sourceDocumentIds },
      },
      orderBy: [
        { sourceFileName: 'asc' },
        { sourceSheetName: 'asc' },
        { sourceRow: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        sourceDocumentId: row.sourceDocumentId,
        rowId: row.rowId,
        status: row.status,
        sourceType: row.sourceType,
        sourceFileName: row.sourceFileName,
        sourceSheetName: row.sourceSheetName,
        sourceRow: row.sourceRow,
        sourceReference: row.sourceReference,
        activityType: row.activityType,
        rawActivityType: row.rawActivityType,
        recordDate: row.recordDate,
        rawRecordDate: row.rawRecordDate,
        quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
        rawQuantity: row.rawQuantity,
        unit: row.unit,
        jurisdictionCountry: row.jurisdictionCountry,
        jurisdictionRegion: row.jurisdictionRegion,
        facilityName: row.facilityName,
        costCad: row.costCad === null || row.costCad === undefined ? null : Number(row.costCad),
        costCurrency: row.costCurrency,
        notes: row.notes,
        issues: row.issues,
        rawSourceRow: row.rawSourceRow,
        matchingStatus: row.matchingStatus,
        reportTreatment: row.reportTreatment,
        scope: row.scope,
        matchedFactorId: row.matchedFactorId,
        matchedFactorName: row.matchedFactorName,
        matchedFactorSourceYear: row.matchedFactorSourceYear,
        matchedFactorValue: row.matchedFactorValue,
        matchedFactorUnit: row.matchedFactorUnit,
        matchedFactorVersion: row.matchedFactorVersion,
        matchedFactorSourceAuthority: row.matchedFactorSourceAuthority,
        matchedFactorSourceDocument: row.matchedFactorSourceDocument,
        matchedFactorVerificationStatus: row.matchedFactorVerificationStatus,
        matchedFactorConfidenceLevel: row.matchedFactorConfidenceLevel,
        matchedFactorAssumptions: row.matchedFactorAssumptions,
        factorSelectionReason: row.factorSelectionReason,
        factorSelectionExplanation: row.factorSelectionExplanation,
        calculationStatus: row.calculationStatus,
        calculationMessage: row.calculationMessage,
        calculatedEmissionsKgCO2e: row.calculatedEmissionsKgCO2e,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  async saveReviewRows(
    organizationId: string,
    dto: SaveSpreadsheetReviewRowsDto,
    userId?: string,
  ) {
    if (!dto.rows?.length) {
      throw new BadRequestException('No spreadsheet review rows provided.');
    }

    const counts = countRows(dto.rows);
    const sourceFileName = getSourceFileName(dto);
    const importBatchId = buildImportBatchId(dto, sourceFileName);
    const sourceStatus = counts.needsReviewCount > 0 ? 'REVIEW_REQUIRED' : 'PROCESSED';
    const extractionJson = buildSpreadsheetExtractionJson(dto);

    const sourceDocument = await this.prisma.$transaction(async (tx) => {
      const existingSource = await tx.document.findFirst({
        where: {
          organizationId,
          type: 'SPREADSHEET',
          importBatchId,
        },
        orderBy: { createdAt: 'asc' },
      });
      const document = existingSource
        ? await tx.document.update({
            where: { id: existingSource.id },
            data: {
              fileName: sourceFileName,
              status: sourceStatus,
              extractedJson: extractionJson,
            },
          })
        : await tx.document.create({
            data: {
              organizationId,
              uploadedById: userId ?? null,
              fileName: sourceFileName,
              fileUrl: `spreadsheet-import://${importBatchId}`,
              mimeType: getSpreadsheetMimeType(dto.sourceType),
              fileSize: null,
              fileHash: null,
              type: 'SPREADSHEET',
              status: sourceStatus,
              extractedJson: extractionJson,
              importBatchId,
            },
          });

      await tx.documentExtraction.upsert({
        where: {
          documentId: document.id,
        },
        create: {
          organizationId,
          documentId: document.id,
          status: sourceStatus,
          extractedJson: extractionJson,
          extractedRows: buildSpreadsheetExtractionRows(document.id, sourceFileName, dto.rows),
          sourceRowCount: dto.rows.length,
          extractedRowCount: dto.rows.length,
          possibleMissingRows: counts.needsReviewCount > 0,
          warning:
            counts.needsReviewCount > 0
              ? `${counts.needsReviewCount} spreadsheet row(s) need review before import.`
              : null,
          extractedAt: new Date(),
        },
        update: {
          organizationId,
          status: sourceStatus,
          extractedJson: extractionJson,
          extractedRows: buildSpreadsheetExtractionRows(document.id, sourceFileName, dto.rows),
          sourceRowCount: dto.rows.length,
          extractedRowCount: dto.rows.length,
          possibleMissingRows: counts.needsReviewCount > 0,
          warning:
            counts.needsReviewCount > 0
              ? `${counts.needsReviewCount} spreadsheet row(s) need review before import.`
              : null,
          extractedAt: new Date(),
        },
      });

      for (const row of dto.rows) {
        const idempotencyKey = buildIdempotencyKey(dto, row);
        await tx.spreadsheetImportReviewRow.upsert({
          where: {
            SpreadsheetImportReviewRow_idempotency_key: {
              organizationId,
              idempotencyKey,
            },
          },
          create: {
            ...buildReviewRowData(organizationId, dto, row, userId, document.id),
            idempotencyKey,
          },
          update: buildReviewRowData(organizationId, dto, row, userId, document.id),
        });
      }

      return document;
    });

    return {
      savedCount: dto.rows.length,
      readyCount: counts.readyCount,
      needsReviewCount: counts.needsReviewCount,
      trackedOnlyCount: counts.trackedOnlyCount,
      sourceDocument: {
        id: sourceDocument.id,
        fileName: sourceDocument.fileName,
        type: sourceDocument.type,
        status: sourceDocument.status,
        createdAt: sourceDocument.createdAt,
      },
      failedRows: [],
    };
  }
}

function parseCsvList(value?: string) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildReviewRowData(
  organizationId: string,
  dto: SaveSpreadsheetReviewRowsDto,
  row: SpreadsheetReviewRowDto,
  userId?: string,
  sourceDocumentId?: string,
): Omit<Prisma.SpreadsheetImportReviewRowUncheckedCreateInput, 'idempotencyKey'> {
  return {
    organizationId,
    sourceDocumentId: sourceDocumentId ?? null,
    createdById: userId ?? null,
    rowId: row.rowId,
    status: row.status,
    sourceType: dto.sourceType,
    sourceFileName: normalizeText(row.sourceFileName) ?? normalizeText(dto.sourceFileName),
    sourceSheetName: normalizeText(row.sourceSheetName),
    sourceRow: normalizeSourceRow(row.sourceRow),
    sourceReference: normalizeText(row.sourceReference),
    activityType: normalizeText(row.activityType),
    rawActivityType: normalizeText(row.rawActivityType),
    recordDate: row.recordDate ? parseDateOnlyUtc(row.recordDate) : null,
    rawRecordDate: toJsonValue(row.rawRecordDate),
    quantity: typeof row.quantity === 'number' ? new Prisma.Decimal(row.quantity) : null,
    rawQuantity: normalizeText(row.rawQuantity),
    unit: normalizeText(row.unit),
    jurisdictionCountry: normalizeText(row.jurisdictionCountry),
    jurisdictionRegion: normalizeText(row.jurisdictionRegion),
    facilityName: normalizeText(row.facilityName),
    costCad: normalizeOptionalCost(row.costCad),
    costCurrency: normalizeText(row.costCurrency),
    notes: normalizeText(row.notes),
    issues: row.issues.map((issue) => ({ ...issue })) as Prisma.InputJsonValue,
    rawSourceRow: toJsonValue(row.rawSourceRow),
    matchingStatus: normalizeText(row.matchingStatus),
    reportTreatment: normalizeText(row.reportTreatment),
    scope: normalizeText(row.scope),
    matchedFactorId: normalizeText(row.matchedFactorId),
    matchedFactorName: normalizeText(row.matchedFactorName),
    matchedFactorSourceYear: row.matchedFactorSourceYear ?? null,
    matchedFactorValue: row.matchedFactorValue ?? null,
    matchedFactorUnit: normalizeText(row.matchedFactorUnit),
    matchedFactorVersion: normalizeText(row.matchedFactorVersion),
    matchedFactorSourceAuthority: normalizeText(row.matchedFactorSourceAuthority),
    matchedFactorSourceDocument: normalizeText(row.matchedFactorSourceDocument),
    matchedFactorVerificationStatus: normalizeText(row.matchedFactorVerificationStatus),
    matchedFactorConfidenceLevel: normalizeText(row.matchedFactorConfidenceLevel),
    matchedFactorAssumptions: normalizeText(row.matchedFactorAssumptions),
    factorSelectionReason: normalizeText(row.factorSelectionReason),
    factorSelectionExplanation: normalizeText(row.factorSelectionExplanation),
    calculatedEmissionsKgCO2e: row.calculatedEmissionsKgCO2e ?? null,
    calculationStatus: normalizeText(row.calculationStatus),
    calculationMessage: normalizeText(row.calculationMessage),
  };
}

function buildIdempotencyKey(
  dto: SaveSpreadsheetReviewRowsDto,
  row: SpreadsheetReviewRowDto,
) {
  return [
    normalizeText(dto.importBatchId) ?? '',
    dto.sourceType,
    normalizeText(row.sourceFileName) ?? normalizeText(dto.sourceFileName) ?? '',
    normalizeText(row.sourceSheetName) ?? '',
    normalizeSourceRow(row.sourceRow) ?? '',
    row.rowId,
  ].join('|');
}

function countRows(rows: SpreadsheetReviewRowDto[]) {
  return {
    readyCount: countRowsByStatus(rows, 'READY'),
    needsReviewCount: countRowsByStatus(rows, 'NEEDS_REVIEW'),
    trackedOnlyCount: countRowsByStatus(rows, 'TRACKED_ONLY'),
  };
}

function countRowsByStatus(rows: SpreadsheetReviewRowDto[], status: SpreadsheetReviewRowStatus) {
  return rows.filter((row) => row.status === status).length;
}

function getSourceFileName(dto: SaveSpreadsheetReviewRowsDto) {
  return (
    normalizeText(dto.sourceFileName) ??
    dto.rows.map((row) => normalizeText(row.sourceFileName)).find(Boolean) ??
    'Spreadsheet import'
  );
}

function buildImportBatchId(dto: SaveSpreadsheetReviewRowsDto, sourceFileName: string) {
  return normalizeText(dto.importBatchId) ?? [
    'spreadsheet',
    dto.sourceType,
    sourceFileName,
  ].join(':');
}

function getSpreadsheetMimeType(sourceType: SpreadsheetImportSourceType) {
  if (sourceType === 'CSV') return 'text/csv';
  if (sourceType === 'EXCEL') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return 'text/plain';
}

function buildSpreadsheetExtractionJson(dto: SaveSpreadsheetReviewRowsDto) {
  return toInputJson({
    sourceType: dto.sourceType,
    sourceFileName: dto.sourceFileName ?? null,
    rows: dto.rows,
  });
}

function buildSpreadsheetExtractionRows(
  documentId: string,
  sourceFileName: string,
  rows: SpreadsheetReviewRowDto[],
) {
  return toInputJson(
    rows.map((row) => buildSpreadsheetExtractionRow(documentId, sourceFileName, row)),
  );
}

function buildSpreadsheetExtractionRow(
  documentId: string,
  sourceFileName: string,
  row: SpreadsheetReviewRowDto,
) {
  return {
    documentId,
    sourceDocumentId: documentId,
    rowId: row.rowId,
    status: row.status,
    sourceFileName,
    activityType: row.activityType,
    rawActivityType: row.rawActivityType ?? null,
    recordDate: row.recordDate ?? null,
    rawRecordDate: row.rawRecordDate ?? null,
    quantity: row.quantity ?? null,
    rawQuantity: row.rawQuantity ?? null,
    unit: row.unit,
    jurisdictionCountry: row.jurisdictionCountry ?? null,
    jurisdictionRegion: row.jurisdictionRegion ?? null,
    facilityName: row.facilityName ?? null,
    costCad: row.costCad ?? null,
    costCurrency: row.costCurrency ?? null,
    sourceReference: row.sourceReference ?? sourceFileName,
    sourceRow: row.sourceRow ?? null,
    sourceSheetName: row.sourceSheetName ?? null,
    sourceTextSnippet: row.rawSourceRow ? JSON.stringify(row.rawSourceRow) : null,
    notes: row.notes ?? null,
    matchingStatus: row.matchingStatus ?? null,
    reportTreatment: row.reportTreatment ?? null,
    scope: row.scope ?? null,
    matchedFactorId: row.matchedFactorId ?? null,
    matchedFactorName: row.matchedFactorName ?? null,
    matchedFactorSourceYear: row.matchedFactorSourceYear ?? null,
    matchedFactorValue: row.matchedFactorValue ?? null,
    matchedFactorUnit: row.matchedFactorUnit ?? null,
    matchedFactorVersion: row.matchedFactorVersion ?? null,
    matchedFactorSourceAuthority: row.matchedFactorSourceAuthority ?? null,
    matchedFactorSourceDocument: row.matchedFactorSourceDocument ?? null,
    matchedFactorVerificationStatus: row.matchedFactorVerificationStatus ?? null,
    matchedFactorConfidenceLevel: row.matchedFactorConfidenceLevel ?? null,
    matchedFactorAssumptions: row.matchedFactorAssumptions ?? null,
    factorSelectionReason: row.factorSelectionReason ?? null,
    factorSelectionExplanation: row.factorSelectionExplanation ?? null,
    calculatedEmissionsKgCO2e: row.calculatedEmissionsKgCO2e ?? null,
    calculationStatus: row.calculationStatus ?? null,
    calculationMessage:
      row.calculationMessage ??
      (row.issues.length ? row.issues.map((issue) => issue.message).join('; ') : null),
    issues: row.issues.map((issue) => ({ ...issue })),
  };
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalCost(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const numericValue =
    typeof value === 'number'
      ? value
      : Number(String(value).trim().replace(/[$,\s]/g, ''));

  return Number.isFinite(numericValue) ? new Prisma.Decimal(numericValue) : null;
}

function normalizeSourceRow(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return normalizeText(value);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined || value === '') {
    return Prisma.JsonNull;
  }

  return value as Prisma.InputJsonValue;
}
