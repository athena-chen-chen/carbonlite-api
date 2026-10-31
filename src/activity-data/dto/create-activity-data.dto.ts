import {
  IsBoolean,
  IsDateString,
  IsEnum,
  Equals,
  IsInt,
  IsNumber,
  Matches,
  Min,
  IsPositive,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ActivityType, RecordSourceType } from '@prisma/client';

export {
  ActivityType as ActivityTypeDto,
  RecordSourceType as RecordSourceTypeDto,
} from '@prisma/client';

export class AirTravelActivityMetadataDto {
  @Type(() => Number)
  @IsInt()
  @Equals(1)
  schemaVersion!: 1;

  @IsString()
  @Matches(/^AIR_TRAVEL$/)
  type!: 'AIR_TRAVEL';

  @Transform(({ value }) => String(value ?? '').trim().toUpperCase())
  @Matches(/^[A-Z]{3}$/)
  originAirport!: string;

  @Transform(({ value }) => String(value ?? '').trim().toUpperCase())
  @Matches(/^[A-Z]{3}$/)
  destinationAirport!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  passengerCount!: number;

  @Transform(({ value }) => String(value ?? '').trim().toUpperCase())
  @IsEnum(['ONE_WAY', 'ROUND_TRIP'])
  tripType!: 'ONE_WAY' | 'ROUND_TRIP';
}

const hasAirTravelMetadata = (value: CreateActivityDataDto) =>
  value.activityMetadata?.type === 'AIR_TRAVEL';

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

  @ValidateIf((value: CreateActivityDataDto) => !hasAirTravelMetadata(value))
  @IsNumber()
  @IsPositive({ message: 'Quantity must be a positive number.' })
  quantity?: number;

  @ValidateIf((value: CreateActivityDataDto) => !hasAirTravelMetadata(value))
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AirTravelActivityMetadataDto)
  activityMetadata?: AirTravelActivityMetadataDto;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  rooms?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  nights?: number;

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
  sourceSheetName?: string;

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

  @IsOptional()
  @IsString()
  calculationStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  calculationMessage?: string;
}
