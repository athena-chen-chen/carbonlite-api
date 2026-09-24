import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ActivityType, RecordSourceType } from '@prisma/client';

export {
  ActivityType as ActivityTypeDto,
  RecordSourceType as RecordSourceTypeDto,
} from '@prisma/client';

export class CreateActivityDataDto {
  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  facility?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  facilityName?: string;

  @IsOptional()
  @IsString()
  assetId?: string;

  @IsOptional()
  @IsString()
  documentId?: string;

  @IsEnum(ActivityType)
  activityType!: ActivityType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  customTypeLabel?: string;

  @IsDateString()
  recordDate!: string;

  @IsOptional()
  @IsBoolean()
  dateEstimated?: boolean;

  @IsOptional()
  @IsString()
  jurisdictionCountry?: string;

  @IsOptional()
  @IsString()
  jurisdictionRegion?: string;

  @IsOptional()
  @IsNumber()
  recordYear?: number;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @IsNumber()
  quantity!: number;

  @IsString()
  @MaxLength(40)
  unit!: string;

  @IsEnum(RecordSourceType)
  sourceType!: RecordSourceType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
  @IsOptional()
  @IsString()
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  sourceDocumentId?: string;

  @IsOptional()
  sourcePage?: string | number;

  @IsOptional()
  sourceRow?: string | number;

  @IsOptional()
  @IsString()
  sourceTextSnippet?: string;

  @IsOptional()
  @IsString()
  importBatchId?: string;

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
  @Type(() => Number)
  @IsNumber()
  calculatedEmissionsKgCO2e?: number;

  @IsOptional()
  @IsString()
  calculationStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  calculationMessage?: string;
}
