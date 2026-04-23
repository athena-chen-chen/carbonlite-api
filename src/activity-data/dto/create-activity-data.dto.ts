import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export enum ActivityTypeDto {
  ELECTRICITY = 'ELECTRICITY',
  NATURAL_GAS = 'NATURAL_GAS',
  DIESEL = 'DIESEL',
  GASOLINE = 'GASOLINE',
  STEAM = 'STEAM',
  WATER = 'WATER',
  WASTE = 'WASTE',
  BUSINESS_TRAVEL = 'BUSINESS_TRAVEL',
  FREIGHT = 'FREIGHT',
  CUSTOM = 'CUSTOM',
}

export enum RecordSourceTypeDto {
  MANUAL = 'MANUAL',
  IMPORT = 'IMPORT',
  API = 'API',
  DOCUMENT_AI = 'DOCUMENT_AI',
}

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

  @IsEnum(ActivityTypeDto)
  activityType!: ActivityTypeDto;

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

  @IsEnum(RecordSourceTypeDto)
  sourceType!: RecordSourceTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}