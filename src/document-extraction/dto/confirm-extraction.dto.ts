import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsObject,
  IsOptional, IsString, MaxLength, ValidateBy, ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_EXTRACTED_REVIEW_ROWS } from '../../documents/document-resource-policy';

// Preserve the service's parseable string dates; date interpretation remains separate.
const IsImportDate = () => ValidateBy({
  name: 'isImportDate',
  validator: {
    validate: value => typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value)),
    defaultMessage: () => 'recordDate must be a valid date string',
  },
});

const IsSourcePosition = (allowPageLabel = false) => ValidateBy({
  name: 'isSourcePosition',
  validator: {
    validate: value => typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
      : typeof value === 'string' && (allowPageLabel
        ? value.trim().length > 0
        : /^\d+$/.test(value) && Number.isSafeInteger(Number(value))),
    defaultMessage: () => allowPageLabel
      ? 'sourcePage must be a non-negative integer or a non-empty page label'
      : 'sourceRow must be a non-negative integer or an integer string',
  },
});

export class ParsedActivityDto {
  @IsString()
  activityType!: string;

  @IsString()
  @IsImportDate()
  recordDate!: string;

  @IsNumber()
  quantity!: number;

  @IsString()
  unit!: string;

  @IsOptional()
  @IsString()
  periodRole?: string;

  @IsOptional()
  @IsString()
  usageType?: string;

  @IsOptional()
  @IsString()
  comparisonType?: string;

  @IsOptional()
  @IsString()
  jurisdictionCountry?: string;

  @IsOptional()
  @IsString()
  jurisdictionRegion?: string;

  @IsOptional()
  @IsString()
  facility?: string;

  @IsOptional()
  @IsString()
  facilityName?: string;

  @IsOptional()
  @IsString()
  sourceReference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  sourceDocumentId?: string;

  @IsOptional()
  @IsString()
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  sourceSheetName?: string;

  @IsOptional()
  @IsString()
  sourceTextSnippet?: string;

  @IsOptional()
  @IsString()
  importBatchId?: string;

  @IsOptional()
  @IsString()
  documentId?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  // Compatibility hints only: prepareCreate discards and recomputes these values.

  @IsOptional()
  @IsString()
  matchingStatus?: string;

  @IsOptional()
  @IsString()
  reportTreatment?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  matchedFactorId?: string;

  @IsOptional()
  @IsString()
  matchedFactorName?: string;

  @IsOptional()
  @IsString()
  matchedFactorUnit?: string;

  @IsOptional()
  @IsString()
  matchedFactorVersion?: string;

  @IsOptional()
  @IsString()
  matchedFactorSourceAuthority?: string;

  @IsOptional()
  @IsString()
  matchedFactorSourceDocument?: string;

  @IsOptional()
  @IsString()
  matchedFactorVerificationStatus?: string;

  @IsOptional()
  @IsString()
  matchedFactorConfidenceLevel?: string;

  @IsOptional()
  @IsString()
  matchedFactorAssumptions?: string;

  @IsOptional()
  @IsString()
  factorSelectionReason?: string;

  @IsOptional()
  @IsString()
  factorSelectionExplanation?: string;

  @IsOptional()
  @IsString()
  calculationStatus?: string;

  @IsOptional()
  @IsString()
  calculationMessage?: string;

  @IsOptional()
  @IsSourcePosition()
  sourceRow?: string | number;

  @IsOptional()
  @IsSourcePosition(true)
  sourcePage?: string | number;

  @IsOptional()
  @IsBoolean()
  dateEstimated?: boolean;

  @IsOptional()
  @IsInt()
  recordYear?: number;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value)
  @IsNumber()
  costCad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  costCurrency?: string;

  @IsOptional()
  @IsNumber()
  matchedFactorSourceYear?: number;

  @IsOptional()
  @IsNumber()
  matchedFactorValue?: number;

  @IsOptional()
  @IsNumber()
  calculatedEmissionsKgCO2e?: number;
}

export class ConfirmExtractionDto {
  @IsString()
  documentId!: string;

  // [] intentionally confirms persisted staged rows. Reject malformed elements
  // before entering the transaction; business eligibility remains server-owned.
  @IsArray()
  @ArrayMaxSize(MAX_EXTRACTED_REVIEW_ROWS)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParsedActivityDto)
  activities!: ParsedActivityDto[];

  @IsOptional()
  @IsString()
  importBatchId?: string;
}
