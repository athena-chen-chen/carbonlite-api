import { IsEnum, IsOptional, IsString, MaxLength, IsNumber } from 'class-validator';

export enum FacilityTypeDto {
  OFFICE = 'OFFICE',
  PLANT = 'PLANT',
  WAREHOUSE = 'WAREHOUSE',
  DATA_CENTER = 'DATA_CENTER',
  OTHER = 'OTHER',
}

export class CreateFacilityDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsEnum(FacilityTypeDto)
  type?: FacilityTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  provinceState?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}