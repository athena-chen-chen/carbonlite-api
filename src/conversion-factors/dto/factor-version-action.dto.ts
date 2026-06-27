import { IsOptional, IsString } from 'class-validator';

export class FactorVersionActionDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  reviewNotes?: string;

  @IsOptional()
  @IsString()
  approvalSource?: string;
}
