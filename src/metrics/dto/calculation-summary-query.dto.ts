import { Allow, IsOptional, IsString } from 'class-validator';

export type IdQueryParam = string | string[];

export class CalculationSummaryQueryDto {
  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;

  @IsOptional()
  @Allow()
  selectedActivityRecordIds?: IdQueryParam;

  @IsOptional()
  @Allow()
  selectedDocumentIds?: IdQueryParam;

  @IsOptional()
  @Allow()
  'selectedActivityRecordIds[]'?: IdQueryParam;

  @IsOptional()
  @Allow()
  'selectedDocumentIds[]'?: IdQueryParam;
}
