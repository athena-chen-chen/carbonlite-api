import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class GenerateReportDto {
  @IsOptional()
  @IsArray()
  metricResultIds?: string[];

  @IsOptional()
  @IsBoolean()
  includeAiSummary?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}