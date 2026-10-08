import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  SpreadsheetImportSourceType,
  SpreadsheetReviewRowStatus,
} from '@prisma/client';

export class SpreadsheetReviewIssueDto {
  @IsString()
  @MaxLength(80)
  code!: string;

  @IsString()
  @MaxLength(80)
  field!: string;

  @IsString()
  @MaxLength(500)
  message!: string;
}

export class SpreadsheetReviewRowDto {
  @IsString()
  @MaxLength(160)
  rowId!: string;

  @IsEnum(SpreadsheetReviewRowStatus)
  status!: SpreadsheetReviewRowStatus;

  @IsString()
  @MaxLength(80)
  activityType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  rawActivityType?: string;

  @ValidateIf((_, value) => value !== null && value !== undefined && value !== '')
  @IsISO8601()
  recordDate?: string | null;

  @IsOptional()
  rawRecordDate?: unknown;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsNumber()
  quantity?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  rawQuantity?: string;

  @IsString()
  @MaxLength(40)
  unit!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  jurisdictionCountry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  jurisdictionRegion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  facilityName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceSheetName?: string;

  @IsOptional()
  sourceRow?: string | number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  costCad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  costCurrency?: string;

  @IsOptional()
  rawSourceRow?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpreadsheetReviewIssueDto)
  issues!: SpreadsheetReviewIssueDto[];

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
  calculationStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  calculationMessage?: string;

  @IsOptional()
  @IsString()
  matchedFactorId?: string;

  @IsOptional()
  @IsString()
  matchedFactorName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  matchedFactorSourceYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  matchedFactorValue?: number;

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
  @MaxLength(1000)
  matchedFactorAssumptions?: string;

  @IsOptional()
  @IsString()
  factorSelectionReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  factorSelectionExplanation?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  calculatedEmissionsKgCO2e?: number;
}

export class SaveSpreadsheetReviewRowsDto {
  @IsEnum(SpreadsheetImportSourceType)
  sourceType!: SpreadsheetImportSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  importBatchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sourceFileName?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SpreadsheetReviewRowDto)
  rows!: SpreadsheetReviewRowDto[];
}
