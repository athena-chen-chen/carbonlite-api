import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { openai } from '../openai/openai.client';
import { access, readFile } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { ActivityType } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import {
  normalizeJurisdictionCountry,
  normalizeJurisdictionRegion,
} from '../metrics/metrics.utils';
import { parseJsonActivityPayload } from '../activity-data/json-activity-records';
import {
  addAppBreadcrumb,
  captureAppError,
  markAppErrorCaptured,
} from '../common/monitoring/capture-app-error';
import {
  PerfTimer,
  SLOW_REQUEST_THRESHOLD_MS,
  timeAsync,
  timeSync,
} from '../common/monitoring/performance-logging';

type ConfidenceLevel = 'high' | 'medium' | 'low';

type ParsedActivityRaw = {
  activityType: string;
  recordDate: string;
  quantity: number;
  unit: string;
  jurisdictionCountry?: string | null;
  jurisdictionRegion?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
};

type ConfidenceField<T> = {
  value: T | null;
  confidence: ConfidenceLevel;
};

type ParsedActivityWithConfidence = {
  activityType: ConfidenceField<string>;
  recordDate: ConfidenceField<string>;
  quantity: ConfidenceField<number>;
  unit: ConfidenceField<string>;
  jurisdictionCountry: ConfidenceField<string>;
  jurisdictionRegion: ConfidenceField<string>;
  sourceReference: ConfidenceField<string>;
  notes: ConfidenceField<string>;
};

@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);
  private readonly fileMissingMessage =
    'Uploaded file is no longer available. Please upload it again.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async extract(
    organizationId: string,
    documentId: string,
    userId?: string,
    userEmail?: string,
  ) {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });

    await this.trackExtractionEvent({
      organizationId,
      userId,
      documentId,
      eventName: 'DOCUMENT_EXTRACT_STARTED',
      metadata: {
        statusBefore: document.status,
        fileType: document.type,
      },
    });
    addAppBreadcrumb('Document extraction started', {
      feature: 'document-extraction',
      operation:
        document.status === 'EXTRACTION_FAILED' ||
        document.status === 'NO_DATA_FOUND'
          ? 'retry-extract'
          : 'extract',
      organizationId,
      entityType: 'Document',
      entityId: documentId,
      metadata: {
        route: '/api/document-extraction/extract',
        method: 'POST',
        statusBefore: document.status,
        fileType: document.type,
      },
    });

    const relativePath = document.fileUrl.replace(/^\/+/, '');
    const absolutePath = join(process.cwd(), relativePath);
    this.logger.log(
      `[DocumentExtraction] retry extract documentId=${documentId} filePath=${absolutePath} storageKey=${document.fileUrl}`,
    );

    try {
      this.validateSupportedFile(document);

      try {
        await access(absolutePath, constants.R_OK);
        this.logger.log(
          `[DocumentExtraction] file exists documentId=${documentId} filePath=${absolutePath}`,
        );
      } catch {
        this.logger.warn(
          `[DocumentExtraction] file missing documentId=${documentId} filePath=${absolutePath} storageKey=${document.fileUrl}`,
        );
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: 'FILE_MISSING' },
        });
        await this.trackExtractionEvent({
          organizationId,
          userId,
          documentId,
          eventName: 'DOCUMENT_EXTRACT_FAILED',
          metadata: {
            reason: 'FILE_MISSING',
          },
        });
        addAppBreadcrumb('Uploaded file missing during extraction', {
          feature: 'document-extraction',
          operation: 'file-missing',
          organizationId,
          entityType: 'Document',
          entityId: documentId,
          metadata: {
            storageKey: document.fileUrl,
          },
        });
        throw new NotFoundException({
          message: this.fileMissingMessage,
          error: 'File Missing',
          statusCode: 404,
          status: 'FILE_MISSING',
        });
      }

      const fileBuffer = await readFile(absolutePath);
      const mimeType = document.mimeType || 'application/octet-stream';
      const base64 = fileBuffer.toString('base64');

      let localText = '';

      if (document.fileName.toLowerCase().endsWith('.json')) {
        return this.extractStructuredJsonDocument({
          organizationId,
          userId,
          documentId,
          fileName: document.fileName,
          fileBuffer,
        });
      }

      if (document.fileName.toLowerCase().endsWith('.csv')) {
        localText = fileBuffer.toString('utf-8');
      }

      const response = await openai.responses.create({
        model: 'gpt-4o-mini',
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You extract operational activity data from invoices, utility bills, receipts, and similar business documents. ' +
                  'Return only the requested structured data. ' +
                  'If a value is missing, return null where allowed. ' +
                  'Supported activityType values: ELECTRICITY, NATURAL_GAS, DIESEL, GASOLINE, AIR_TRAVEL, STEAM, WATER, WASTE, HOTEL, SHIPPING, CUSTOM. ' +
                  'Prefer the most explicit quantity and unit shown in the document.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  `
Extract ALL activity records from the document.

IMPORTANT:
- If the document contains a table, extract EVERY row as a separate activity.
- Do NOT skip any rows.
- Return ALL detected activities.
- Even if some rows look less important, still include them.

For CSV or tabular data:
- Each row = one activity
- Map columns to fields:
  - ActivityType → activityType
  - Date → recordDate
  - Quantity → quantity
  - Unit → unit
  - Province, Jurisdiction, Jurisdiction Region, Region, State, State/Province, Facility Province → jurisdictionRegion
  - Country → jurisdictionCountry

Normalize activity types:
- Hotel, Hotels, Hotel Stay, Accommodation, Lodging → HOTEL
- Electricity → ELECTRICITY
- Diesel → DIESEL
- Gasoline → GASOLINE
- Natural Gas → NATURAL_GAS
- Water → WATER

Return all rows as activities array.
` +
                  'If the document contains a fuel invoice, prefer DIESEL or GASOLINE. ' +
                  'If it contains a utility bill, prefer ELECTRICITY or NATURAL_GAS.',
              },
              {
                type: 'input_file',
                filename: document.fileName,
                file_data: `data:${mimeType};base64,${base64}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'activity_extraction',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                activities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      activityType: {
                        type: 'string',
                        enum: [
                          'ELECTRICITY',
                          'NATURAL_GAS',
                          'DIESEL',
                          'GASOLINE',
                          'AIR_TRAVEL',
                          'STEAM',
                          'WATER',
                          'WASTE',
                          'HOTEL',
                          'SHIPPING',
                          'CUSTOM',
                        ],
                      },
                      recordDate: { type: 'string' },
                      quantity: { type: 'number' },
                      unit: { type: 'string' },
                      jurisdictionCountry: {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      jurisdictionRegion: {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      sourceReference: {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                      },
                      notes: {
                        anyOf: [{ type: 'string' }, { type: 'null' }],
                      },
                    },
                    required: [
                      'activityType',
                      'recordDate',
                      'quantity',
                      'unit',
                      'jurisdictionCountry',
                      'jurisdictionRegion',
                      'sourceReference',
                      'notes',
                    ],
                  },
                },
              },
              required: ['activities'],
            },
          },
        },
      });

      const rawText = response.output_text;
      const parsed = JSON.parse(rawText) as { activities: ParsedActivityRaw[] };

      const parsedActivities = (parsed.activities ?? []).map((activity) =>
        this.addConfidence(activity),
      );
      const sourceRowCount = localText
        ? this.estimateSourceRowCount(document, localText)
        : 0;

      const extractedRowCount = parsedActivities.length;
      const possibleMissingRows =
        sourceRowCount > 0 && extractedRowCount < sourceRowCount;

      const warning = possibleMissingRows
        ? `Possible missing rows: source has ${sourceRowCount} rows, AI extracted ${extractedRowCount}.`
        : null;
      const status = extractedRowCount > 0 ? 'REVIEW_REQUIRED' : 'NO_DATA_FOUND';

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status },
      });

      if (extractedRowCount === 0) {
        this.logger.warn(
          `[DocumentExtraction] no data found documentId=${documentId} sourceRowCount=${sourceRowCount}`,
        );
        addAppBreadcrumb('No emissions data found', {
          feature: 'document-extraction',
          operation: 'no-data-found',
          organizationId,
          entityType: 'Document',
          entityId: documentId,
          metadata: {
            sourceRowCount,
            extractedRowCount,
          },
        });
      } else {
        this.logger.log(
          `[DocumentExtraction] completed documentId=${documentId} extractedRowCount=${extractedRowCount} sourceRowCount=${sourceRowCount}`,
        );
      }

      const extractionResponse = {
        documentId,
        status,
        parsedActivities,
        sourceRowCount,
        extractedRowCount,
        possibleMissingRows,
        warning,
        extractedAt: new Date().toISOString(),
      };

      await this.saveExtractionResult({
        organizationId,
        documentId,
        status,
        parsedActivities,
        sourceRowCount,
        extractedRowCount,
        possibleMissingRows,
        warning,
      });

      await this.auditLog.log({
        organizationId,
        userId,
        action: 'EXTRACT_DOCUMENT',
        entityType: 'Document',
        entityId: documentId,
        description:
          status === 'NO_DATA_FOUND'
            ? 'Extracted document but no emissions data was detected'
            : 'Extracted document',
        newValue: {
          status,
          sourceRowCount,
          extractedRowCount,
          possibleMissingRows,
        },
      });

      await this.trackExtractionEvent({
        organizationId,
        userId,
        documentId,
        eventName:
          extractedRowCount > 0
            ? 'DOCUMENT_EXTRACT_SUCCEEDED'
            : 'DOCUMENT_EXTRACT_FAILED',
        metadata: {
          status,
          sourceRowCount,
          extractedRowCount,
          possibleMissingRows,
          reason: extractedRowCount > 0 ? undefined : 'NO_DATA_FOUND',
        },
      });

      return extractionResponse;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      if (this.isMissingFileError(error)) {
        this.logger.warn(
          `[DocumentExtraction] file missing during read documentId=${documentId} filePath=${absolutePath} storageKey=${document.fileUrl}`,
        );
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: 'FILE_MISSING' },
        });
        await this.trackExtractionEvent({
          organizationId,
          userId,
          documentId,
          eventName: 'DOCUMENT_EXTRACT_FAILED',
          metadata: {
            reason: 'FILE_MISSING',
          },
        });
        addAppBreadcrumb('Uploaded file missing during extraction', {
          feature: 'document-extraction',
          operation: 'file-missing',
          organizationId,
          entityType: 'Document',
          entityId: documentId,
          metadata: {
            storageKey: document.fileUrl,
          },
        });
        throw new NotFoundException({
          message: this.fileMissingMessage,
          error: 'File Missing',
          statusCode: 404,
          status: 'FILE_MISSING',
        });
      }

      if (error instanceof BadRequestException) {
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: 'EXTRACTION_FAILED' },
        });
        await this.trackExtractionEvent({
          organizationId,
          userId,
          documentId,
          eventName: 'DOCUMENT_EXTRACT_FAILED',
          metadata: {
            reason: 'BAD_REQUEST',
          },
        });
        throw error;
      }

      this.logger.error(
        `[DocumentExtraction] extraction failed documentId=${documentId} filePath=${absolutePath} storageKey=${document.fileUrl} reason=${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      captureAppError(error, {
        feature: 'document-extraction',
        operation:
          document.status === 'EXTRACTION_FAILED' ||
          document.status === 'NO_DATA_FOUND'
            ? 'retry-extract'
            : 'extract',
        userId,
        userEmail,
        organizationId,
        entityType: 'Document',
        entityId: documentId,
        metadata: {
          route: '/api/document-extraction/extract',
          method: 'POST',
          storageKey: document.fileUrl,
          mimeType: document.mimeType,
          documentStatus: document.status,
        },
      });
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'EXTRACTION_FAILED' },
      });

      await this.trackExtractionEvent({
        organizationId,
        userId,
        documentId,
        eventName: 'DOCUMENT_EXTRACT_FAILED',
        metadata: {
          reason: 'UNEXPECTED_ERROR',
        },
      });

      const friendlyError = new InternalServerErrorException(
        'Extraction failed. Please try again or upload the file again.',
      );
      markAppErrorCaptured(friendlyError);
      throw friendlyError;
    }
  }

  private validateSupportedFile(document: {
    id: string;
    organizationId: string;
    fileName: string;
    mimeType: string | null;
  }) {
    const fileName = document.fileName.toLowerCase();
    const mimeType = document.mimeType?.toLowerCase() ?? '';
    const supportedExtensions = [
      '.pdf',
      '.csv',
      '.xlsx',
      '.xls',
      '.png',
      '.jpg',
      '.jpeg',
      '.json',
    ];
    const supportedMimeTypes = [
      'application/pdf',
      'text/csv',
      'application/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'image/png',
      'image/jpeg',
      'application/json',
      'text/json',
    ];

    const hasSupportedExtension = supportedExtensions.some((extension) =>
      fileName.endsWith(extension),
    );
    const hasSupportedMimeType =
      Boolean(mimeType) &&
      supportedMimeTypes.some((supportedMimeType) =>
        mimeType.startsWith(supportedMimeType),
      );

    if (!hasSupportedExtension && !hasSupportedMimeType) {
      this.logger.warn(
        `[DocumentExtraction] unsupported file type documentId=${document.id} fileName=${document.fileName} mimeType=${document.mimeType}`,
      );
      addAppBreadcrumb('Unsupported document type', {
        feature: 'document-extraction',
        operation: 'unsupported-file-type',
        organizationId: document.organizationId,
        entityType: 'Document',
        entityId: document.id,
        metadata: {
          mimeType: document.mimeType,
          fileExtension: document.fileName.includes('.')
            ? document.fileName.split('.').pop()
            : undefined,
        },
      });
      throw new BadRequestException(
        'Unsupported file type. Please upload a PDF, CSV, XLSX, PNG, JPG, or JSON file.',
      );
    }
  }

  private async extractStructuredJsonDocument(input: {
    organizationId: string;
    userId?: string;
    documentId: string;
    fileName: string;
    fileBuffer: Buffer;
  }) {
    const records = parseJsonActivityPayload({
      jsonContent: input.fileBuffer.toString('utf-8'),
    });
    const parsedActivities = records.map((record) =>
      this.addConfidence(this.normalizeActivityForExtraction(record, input.fileName)),
    );
    const extractedRowCount = parsedActivities.length;
    const status = extractedRowCount > 0 ? 'REVIEW_REQUIRED' : 'NO_DATA_FOUND';
    const extractionResponse = {
      documentId: input.documentId,
      status,
      parsedActivities,
      sourceRowCount: records.length,
      extractedRowCount,
      possibleMissingRows: false,
      warning: null,
      extractedAt: new Date().toISOString(),
    };

    await this.prisma.document.update({
      where: { id: input.documentId },
      data: { status },
    });

    await this.saveExtractionResult({
      organizationId: input.organizationId,
      documentId: input.documentId,
      status,
      parsedActivities,
      sourceRowCount: records.length,
      extractedRowCount,
      possibleMissingRows: false,
      warning: null,
    });

    await this.auditLog.log({
      organizationId: input.organizationId,
      userId: input.userId,
      action: 'EXTRACT_DOCUMENT',
      entityType: 'Document',
      entityId: input.documentId,
      description:
        status === 'NO_DATA_FOUND'
          ? 'Extracted JSON document but no activity records were detected'
          : 'Extracted JSON document',
      newValue: {
        status,
        sourceRowCount: records.length,
        extractedRowCount,
        possibleMissingRows: false,
      },
    });

    await this.trackExtractionEvent({
      organizationId: input.organizationId,
      userId: input.userId,
      documentId: input.documentId,
      eventName:
        extractedRowCount > 0
          ? 'DOCUMENT_EXTRACT_SUCCEEDED'
          : 'DOCUMENT_EXTRACT_FAILED',
      metadata: {
        status,
        sourceRowCount: records.length,
        extractedRowCount,
        possibleMissingRows: false,
        reason: extractedRowCount > 0 ? undefined : 'NO_DATA_FOUND',
        sourceFormat: 'JSON',
      },
    });

    return extractionResponse;
  }

  private normalizeActivityForExtraction(
    activity: Record<string, unknown>,
    fallbackSourceReference: string,
  ): ParsedActivityRaw {
    const quantity = Number(
      this.readAliasedField(activity, [
        'quantity',
        'Quantity',
        'amount',
        'Amount',
        'usage',
        'Usage',
      ]),
    );

    return {
      activityType: this.normalizeActivityType(
        this.readAliasedField(activity, [
          'activityType',
          'Activity Type',
          'activity type',
          'ActivityType',
          'category',
          'Category',
        ]),
      ),
      recordDate: this.readAliasedField(activity, [
        'recordDate',
        'Record Date',
        'date',
        'Date',
        'startDate',
        'Start Date',
      ]),
      quantity: Number.isFinite(quantity) ? quantity : NaN,
      unit: this.readAliasedField(activity, ['unit', 'Unit', 'units', 'Units']),
      jurisdictionCountry: normalizeJurisdictionCountry(
        this.readAliasedField(activity, ['jurisdictionCountry', 'country', 'Country']),
      ),
      jurisdictionRegion: normalizeJurisdictionRegion(
        this.readAliasedField(activity, [
          'jurisdictionRegion',
          'Jurisdiction Region',
          'jurisdiction',
          'Jurisdiction',
          'province',
          'Province',
          'region',
          'Region',
          'state',
          'State',
          'State/Province',
          'stateProvince',
          'facilityProvince',
          'Facility Province',
        ]),
      ),
      sourceReference:
        this.readAliasedField(activity, [
          'sourceReference',
          'Source Reference',
          'sourceFile',
          'sourceFileName',
        ]) ?? fallbackSourceReference,
      notes: this.readAliasedField(activity, ['notes', 'Notes']),
    };
  }

  private isMissingFileError(error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }

  private estimateSourceRowCount(document: { fileName: string }, fileText: string): number {
    const fileName = document.fileName.toLowerCase();

  // First pass: CSV
  if (fileName.endsWith('.csv')) {
    const lines = fileText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) return 0;

    // assume first line is header
    return lines.length - 1;
  }

  // Fallback: rough table-like line detection
  const lines = fileText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidateLines = lines.filter((line) => {
    const normalized = line.toLowerCase();

    const looksLikeHeader =
      normalized.includes('quantity') &&
      normalized.includes('unit');

    if (looksLikeHeader) return false;

    const hasNumber = /\d/.test(line);
    const hasCommaOrPipe = /,|\|/.test(line);

    return hasNumber && hasCommaOrPipe;
  });

  return candidateLines.length;
}
  async confirmImport(
    organizationId: string,
    documentId: string,
    activities: any[],
    userId?: string,
    importBatchId?: string,
  ) {
    const totalTimer = new PerfTimer();

    const { result: validationResult, durationMs: validationDurationMs } =
      await timeAsync(async () => {
        const document = await this.prisma.document.findFirst({
          where: { id: documentId, organizationId },
        });

        if (!document) {
          throw new NotFoundException('Document not found');
        }

        const existingImport = await this.prisma.activityData.findFirst({
          where: { organizationId, sourceDocumentId: documentId },
          select: { id: true },
        });

        if (document.importedAt || existingImport) {
          throw new ConflictException('This document has already been imported.');
        }

        return { document };
      });
    const { document } = validationResult;

    const { result: normalizedActivities, durationMs: parseDurationMs } = timeSync(
      () => activities.map((activity) => this.normalizeActivityForImport(activity)),
    );
    const stableImportBatchId =
      importBatchId?.trim() || `document-${documentId}`;
    const { result: createdIds, durationMs: databaseInsertUpdateDurationMs } =
      await timeAsync(() =>
        this.prisma.$transaction(async (tx) => {
          const ids: string[] = [];
          const claimedDocument = await tx.document.updateMany({
            where: {
              id: documentId,
              organizationId,
              importedAt: null,
            },
            data: {
              status: 'IMPORTED',
              importedAt: new Date(),
              importBatchId: stableImportBatchId,
            },
          });

          if (claimedDocument.count === 0) {
            throw new ConflictException(
              'This document has already been imported.',
            );
          }

          for (const normalized of normalizedActivities) {
            const row = await tx.activityData.create({
              data: {
                organizationId,
                documentId,
                activityType: normalized.activityType as any,
                recordDate: new Date(normalized.recordDate),
                jurisdictionCountry: normalized.jurisdictionCountry ?? null,
                jurisdictionRegion: normalized.jurisdictionRegion ?? null,
                quantity: normalized.quantity,
                unit: normalized.unit,
                sourceType: 'DOCUMENT_AI' as any,
                sourceReference: normalized.sourceReference ?? null,
                sourceDocumentId: documentId,
                sourceFileName: document.fileName,
                importBatchId: stableImportBatchId,
                notes: normalized.notes ?? null,
              },
            });

            ids.push(row.id);
          }

          return ids;
        }),
      );

    if (createdIds.length > 0) {
      await this.activityTracking.track({
        organizationId,
        userId,
        eventName: 'ACTIVITY_RECORD_IMPORTED',
        entityType: 'Document',
        entityId: documentId,
        metadata: {
          count: createdIds.length,
          sourceType: 'DOCUMENT_AI',
          importBatchId: stableImportBatchId,
        },
      });
    }

    this.logImportPerformance('documentExtractionConfirmImport', {
      totalDurationMs: totalTimer.elapsedMs(),
      parseDurationMs,
      validationDurationMs,
      databaseInsertUpdateDurationMs,
      count: createdIds.length,
    });

    return {
      count: createdIds.length,
      createdIds,
      importBatchId: stableImportBatchId,
    };
  }

  async findLatest(organizationId: string, documentId: string) {
    const extraction = await this.prisma.documentExtraction.findFirst({
      where: {
        organizationId,
        documentId,
      },
      orderBy: {
        extractedAt: 'desc',
      },
    });

    if (!extraction) {
      throw new NotFoundException('No extraction results found for this document.');
    }

    return {
      documentId: extraction.documentId,
      status: extraction.status,
      parsedActivities: extraction.extractedRows,
      sourceRowCount: extraction.sourceRowCount,
      extractedRowCount: extraction.extractedRowCount,
      possibleMissingRows: extraction.possibleMissingRows,
      warning: extraction.warning,
      extractedAt: extraction.extractedAt,
    };
  }

  private async saveExtractionResult(input: {
    organizationId: string;
    documentId: string;
    status: 'REVIEW_REQUIRED' | 'NO_DATA_FOUND';
    parsedActivities: ParsedActivityWithConfidence[];
    sourceRowCount: number;
    extractedRowCount: number;
    possibleMissingRows: boolean;
    warning: string | null;
  }) {
    await this.prisma.documentExtraction.upsert({
      where: {
        documentId: input.documentId,
      },
      create: {
        organizationId: input.organizationId,
        documentId: input.documentId,
        status: input.status,
        extractedJson: {
          activities: input.parsedActivities,
        },
        extractedRows: input.parsedActivities,
        sourceRowCount: input.sourceRowCount,
        extractedRowCount: input.extractedRowCount,
        possibleMissingRows: input.possibleMissingRows,
        warning: input.warning,
        extractedAt: new Date(),
      },
      update: {
        organizationId: input.organizationId,
        status: input.status,
        extractedJson: {
          activities: input.parsedActivities,
        },
        extractedRows: input.parsedActivities,
        sourceRowCount: input.sourceRowCount,
        extractedRowCount: input.extractedRowCount,
        possibleMissingRows: input.possibleMissingRows,
        warning: input.warning,
        extractedAt: new Date(),
      },
    });
  }

  private async trackExtractionEvent(input: {
    organizationId: string;
    userId?: string;
    documentId: string;
    eventName: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.activityTracking.track({
      organizationId: input.organizationId,
      userId: input.userId,
      eventName: input.eventName,
      entityType: 'Document',
      entityId: input.documentId,
      metadata: input.metadata,
    });
  }

  private logImportPerformance(
    operation: string,
    timings: {
      totalDurationMs: number;
      parseDurationMs: number;
      validationDurationMs: number;
      databaseInsertUpdateDurationMs: number;
      count: number;
    },
  ) {
    const message = [
      `${operation} total=${timings.totalDurationMs}ms`,
      `parse=${timings.parseDurationMs}ms`,
      `validation=${timings.validationDurationMs}ms`,
      `databaseInsertUpdate=${timings.databaseInsertUpdateDurationMs}ms`,
      `records=${timings.count}`,
    ].join(' ');

    if (timings.totalDurationMs > SLOW_REQUEST_THRESHOLD_MS) {
      this.logger.warn(`SLOW ${message}`);
      return;
    }

    this.logger.log(message);
  }

  private addConfidence(activity: ParsedActivityRaw): ParsedActivityWithConfidence {
    return {
      activityType: {
        value: activity.activityType ?? null,
        confidence: activity.activityType ? 'high' : 'low',
      },
      recordDate: {
        value: activity.recordDate ?? null,
        confidence: this.isValidDate(activity.recordDate) ? 'high' : 'low',
      },
      quantity: {
        value: typeof activity.quantity === 'number' ? activity.quantity : null,
        confidence:
          typeof activity.quantity === 'number' && activity.quantity > 0
            ? 'high'
            : 'low',
      },
      unit: {
        value: activity.unit ?? null,
        confidence: this.getUnitConfidence(activity.unit),
      },
      jurisdictionCountry: {
        value: activity.jurisdictionCountry ?? null,
        confidence: activity.jurisdictionCountry ? 'high' : 'low',
      },
      jurisdictionRegion: {
        value: activity.jurisdictionRegion ?? null,
        confidence: activity.jurisdictionRegion ? 'high' : 'low',
      },
      sourceReference: {
        value: activity.sourceReference ?? null,
        confidence: activity.sourceReference ? 'high' : 'low',
      },
      notes: {
        value: activity.notes ?? null,
        confidence: activity.notes ? 'medium' : 'low',
      },
    };
  }

  private normalizeActivityForImport(activity: any): ParsedActivityRaw {
    const normalizedActivityType = this.normalizeActivityType(
      this.readAliasedField(activity, [
        'activityType',
        'Activity Type',
        'activity type',
        'ActivityType',
        'category',
        'Category',
      ]),
    );
    const normalizedCountry = normalizeJurisdictionCountry(
      this.readAliasedField(activity, ['jurisdictionCountry', 'country', 'Country']),
    );
    const normalizedRegion = normalizeJurisdictionRegion(
      this.readAliasedField(activity, [
        'jurisdictionRegion',
        'Jurisdiction Region',
        'jurisdiction',
        'Jurisdiction',
        'province',
        'Province',
        'region',
        'Region',
        'state',
        'State',
        'State/Province',
        'stateProvince',
        'facilityProvince',
        'Facility Province',
      ]),
    );
    const normalized: ParsedActivityRaw = {
      activityType: normalizedActivityType,
      recordDate: this.readAliasedField(activity, [
        'recordDate',
        'Record Date',
        'date',
        'Date',
      ]),
      quantity: Number(
        this.readAliasedField(activity, [
          'quantity',
          'Quantity',
          'amount',
          'Amount',
          'usage',
          'Usage',
        ]),
      ),
      unit: this.readAliasedField(activity, ['unit', 'Unit', 'units', 'Units']),
      jurisdictionCountry: normalizedCountry,
      jurisdictionRegion: normalizedRegion,
      sourceReference: this.readAliasedField(activity, [
        'sourceReference',
        'Source Reference',
        'source reference',
        'reference',
        'Reference',
      ]),
      notes: this.readAliasedField(activity, ['notes', 'Notes']),
    };

    if (!normalized.activityType) {
      throw new BadRequestException('activityType is required for import.');
    }

    if (!normalized.recordDate || !this.isValidDate(normalized.recordDate)) {
      throw new BadRequestException('recordDate is invalid or missing.');
    }

    if (
      typeof normalized.quantity !== 'number' ||
      Number.isNaN(normalized.quantity) ||
      normalized.quantity <= 0
    ) {
      throw new BadRequestException('quantity must be a positive number.');
    }

    if (!normalized.unit) {
      throw new BadRequestException('unit is required for import.');
    }

    return normalized;
  }

  private unwrapField(value: any): any {
    if (
      value &&
      typeof value === 'object' &&
      'value' in value &&
      'confidence' in value
    ) {
      return value.value;
    }

    return value;
  }

  private readAliasedField(activity: any, keys: string[]): any {
    for (const key of keys) {
      const value = this.unwrapField(activity?.[key]);
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }

    return null;
  }

  private isValidDate(value: string | null | undefined): boolean {
    if (!value) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime());
  }

  private getUnitConfidence(unit: string | null | undefined): ConfidenceLevel {
    if (!unit) return 'low';

    const normalized = unit.trim().toLowerCase();

    const highConfidenceUnits = [
      'liters',
      'liter',
      'l',
      'kwh',
      'm3',
      'm³',
      'gj',
      'kg',
      'tonnes',
      'tons',
    ];

    if (highConfidenceUnits.includes(normalized)) {
      return 'high';
    }

    return 'medium';
  }
  private normalizeActivityType(rawType?: string | null) {
  const original = String(rawType ?? '').trim();
  const value = original
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const map: Record<string, string> = {
    BUSINESS_TRAVEL: 'AIR_TRAVEL',
    BUSINESS_TRIP: 'AIR_TRAVEL',
    FLIGHT: 'AIR_TRAVEL',
    AIR: 'AIR_TRAVEL',
    AIR_TRAVEL: 'AIR_TRAVEL',
    AIRFARE: 'AIR_TRAVEL',
    AIR_TICKET: 'AIR_TRAVEL',

    FUEL: 'DIESEL',
    DIESEL_FUEL: 'DIESEL',
    DIESEL: 'DIESEL',
    GASOLINE: 'GASOLINE',
    PETROL: 'GASOLINE',

    POWER: 'ELECTRICITY',
    UTILITY_ELECTRICITY: 'ELECTRICITY',
    ELECTRICITY: 'ELECTRICITY',
    ELECTRIC: 'ELECTRICITY',

    GAS: 'NATURAL_GAS',
    NATURAL_GAS: 'NATURAL_GAS',
    NATURALGAS: 'NATURAL_GAS',
    WATER: 'WATER',
    WASTE: 'WASTE',
    HOTEL: 'HOTEL',
    HOTELS: 'HOTEL',
    HOTEL_STAY: 'HOTEL',
    HOTEL_STAYS: 'HOTEL',
    ACCOMMODATION: 'HOTEL',
    LODGING: 'HOTEL',
    SHIPPING: 'SHIPPING',
    FREIGHT: 'SHIPPING',
    STEAM: 'STEAM',
    CUSTOM: 'CUSTOM',
  };

  return map[value] ?? (Object.values(ActivityType).includes(value as ActivityType) ? value : 'CUSTOM');
}
}
