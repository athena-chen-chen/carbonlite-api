import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize = 20;

  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';

  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() from?: string; // YYYY-MM-DD
  @IsOptional() @IsString() to?: string;   // YYYY-MM-DD
  @IsOptional() @Type(() => Number) @IsInt() year?: number; // for Factors
}
