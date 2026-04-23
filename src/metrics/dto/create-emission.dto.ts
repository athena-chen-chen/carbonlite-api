
import { IsDateString, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEmissionDto {
  @IsDateString()
  date!: string; // YYYY-MM-DD

  @IsString()
  scope!: string;

  @IsString()
  category!: string;

  @IsString()
  activity!: string;

  @Type(() => Number)
  @IsNumber()
  amount!: number;

  @IsString()
  unit!: string;

  @Type(() => Number)
  @IsNumber()
  factor!: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  factorId?: string;
}
