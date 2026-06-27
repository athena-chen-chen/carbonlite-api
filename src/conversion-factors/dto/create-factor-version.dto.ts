import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { FactorConfidenceLevel } from '@prisma/client';

export class CreateFactorVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  version?: string;

  @IsOptional()
  @IsNumber()
  factorValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  inputUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  resultUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  jurisdictionCountry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  jurisdictionRegion?: string;

  @IsOptional()
  @IsInt()
  factorYear?: number;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string;

  @IsOptional()
  @IsEnum(FactorConfidenceLevel)
  confidenceLevel?: FactorConfidenceLevel;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  sourcePage?: string;

  @IsOptional()
  @IsString()
  sourceTable?: string;

  @IsOptional()
  @IsString()
  sourceSection?: string;

  @IsOptional()
  @IsString()
  sourceRow?: string;

  @IsOptional()
  @IsString()
  sourceColumn?: string;

  @IsOptional()
  @IsString()
  citationText?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
