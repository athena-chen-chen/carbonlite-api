import { IsOptional, IsString } from 'class-validator';

export class CalculationSummaryQueryDto {
  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;

  @IsOptional()
  @IsString()
  selectedActivityRecordIds?: string;

  @IsOptional()
  @IsString()
  selectedDocumentIds?: string;
}
