import { IsOptional, IsString } from 'class-validator';

export class SpreadsheetReviewRowQueryDto {
  @IsOptional()
  @IsString()
  sourceDocumentIds?: string;
}
