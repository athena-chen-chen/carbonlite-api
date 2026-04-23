import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ActivityTypeDto } from '../../activity-data/dto/create-activity-data.dto';

export enum FactorTypeDto {
  EMISSION = 'EMISSION',
  ENERGY = 'ENERGY',
  COST = 'COST',
  CUSTOM = 'CUSTOM',
}

export class CreateConversionFactorDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEnum(FactorTypeDto)
  type!: FactorTypeDto;

  @IsOptional()
  @IsEnum(ActivityTypeDto)
  activityType?: ActivityTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @IsString()
  @MaxLength(40)
  unit!: string;

  @IsNumber()
  factorValue!: number;

  @IsString()
  @MaxLength(40)
  resultUnit!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}