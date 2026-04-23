import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateFactorDto {
  @IsString() category!: string;
  @IsString() subCategory!: string;
  @IsNumber() factorValue!: number;
  @IsString() unit!: string;
  @IsString() source!: string;
  @IsInt() @Min(1900) year!: number;
  @IsString() region!: string;
  @IsString() scope!: string;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateFactorDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() subCategory?: string;
  @IsOptional() @IsNumber() factorValue?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsInt() @Min(1900) year?: number;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsString() notes?: string;
}
