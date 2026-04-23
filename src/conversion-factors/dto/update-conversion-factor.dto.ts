import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { CreateConversionFactorDto } from './create-conversion-factor.dto';
export class UpdateFactorDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() subCategory?: string;
  @IsOptional() @IsNumber() factorValue?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsInt() year?: number;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsString() notes?: string | null;
}


export class UpdateConversionFactorDto extends PartialType(
  CreateConversionFactorDto,
) {}