import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
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
  @IsString()
  importBatchId?: string;
}
