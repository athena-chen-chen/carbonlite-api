import {
  IsArray,
  IsString,
  IsNumber,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ParsedActivityDto {
  @IsString()
  activityType!: string;

  @IsString()
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

  @IsString()
  sourceReference?: string;

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
  @Type(() => Number)
  @IsNumber()
  costCad?: number;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  costCurrency?: string;

  @IsOptional()
  @IsString()
  importBatchId?: string;
}

export class ConfirmExtractionDto {
  @IsString()
  documentId!: string;

  @IsArray()
  activities!: ParsedActivityDto[];

  @IsOptional()
  @IsString()
  importBatchId?: string;
}
