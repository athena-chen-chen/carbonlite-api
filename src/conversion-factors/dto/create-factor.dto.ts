import { IsNumber, IsOptional, IsString } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';

export class CreateFactorDto {
  @IsString()
  name!: string;

  @IsString() // e.g. "Scope 1" | "Scope 2" | "Scope 3"
  scope!: string;

  @IsString() // e.g. "kg CO2e / L"
  unit!: string;

  @Type(() => Number)
  @IsNumber()
  value!: number;

  @IsString()
  source!: string;

  @IsOptional()
  @IsString()
  method?: string;
}

export class UpdateFactorDto extends PartialType(CreateFactorDto) {}
