import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { openai } from '../openai/openai.client';
import { readFile } from 'fs/promises';
import { join } from 'path';

type ConfidenceLevel = 'high' | 'medium' | 'low';

type ParsedActivityRaw = {
  activityType: string;
  recordDate: string;
  quantity: number;
  unit: string;
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
  sourceReference: ConfidenceField<string>;
  notes: ConfidenceField<string>;
};

@Injectable()
export class DocumentExtractionService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaultOrganizationId = 'demo-org-id';

  async extract(documentId: string) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    const relativePath = document.fileUrl.replace(/^\/+/, '');
    const absolutePath = join(process.cwd(), relativePath);

    const fileBuffer = await readFile(absolutePath);
    const mimeType = document.mimeType || 'application/octet-stream';
    const base64 = fileBuffer.toString('base64');

let localText = '';

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
                'Supported activityType values: ELECTRICITY, NATURAL_GAS, DIESEL, GASOLINE, STEAM, WATER, WASTE, BUSINESS_TRAVEL, FREIGHT, CUSTOM. ' +
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
                        'STEAM',
                        'WATER',
                        'WASTE',
                        'BUSINESS_TRAVEL',
                        'FREIGHT',
                        'CUSTOM',
                      ],
                    },
                    recordDate: { type: 'string' },
                    quantity: { type: 'number' },
                    unit: { type: 'string' },
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
    return {
      documentId,
      status: 'COMPLETED',
      parsedActivities,
       sourceRowCount,
  extractedRowCount,
  possibleMissingRows,
  warning,
    };
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
  async confirmImport(documentId: string, activities: any[]) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    const createdIds: string[] = [];

    for (const activity of activities) {
      const normalized = this.normalizeActivityForImport(activity);

      const row = await this.prisma.activityData.create({
        data: {
          organizationId: this.defaultOrganizationId,
          documentId,
          activityType: normalized.activityType as any,
          recordDate: new Date(normalized.recordDate),
          quantity: normalized.quantity,
          unit: normalized.unit,
          sourceType: 'DOCUMENT_AI' as any,
          sourceReference: normalized.sourceReference ?? null,
          notes: normalized.notes ?? null,
        },
      });

      createdIds.push(row.id);
    }

    return {
      count: createdIds.length,
      createdIds,
    };
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
    const normalized: ParsedActivityRaw = {
      activityType: this.unwrapField(activity.activityType),
      recordDate: this.unwrapField(activity.recordDate),
      quantity: this.unwrapField(activity.quantity),
      unit: this.unwrapField(activity.unit),
      sourceReference: this.unwrapField(activity.sourceReference),
      notes: this.unwrapField(activity.notes),
    };

    if (!normalized.activityType) {
      throw new Error('activityType is required for import.');
    }

    if (!normalized.recordDate || !this.isValidDate(normalized.recordDate)) {
      throw new Error('recordDate is invalid or missing.');
    }

    if (
      typeof normalized.quantity !== 'number' ||
      Number.isNaN(normalized.quantity) ||
      normalized.quantity <= 0
    ) {
      throw new Error('quantity must be a positive number.');
    }

    if (!normalized.unit) {
      throw new Error('unit is required for import.');
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
}