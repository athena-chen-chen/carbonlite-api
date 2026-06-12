import {
  ArrayMinSize,
  IsArray,
  IsString,
  IsNumber,
  IsOptional,
} from 'class-validator';

export class ParsedActivityDto {
  @IsString()
  activityType!: string;

  @IsString()
  recordDate!: string;

  @IsNumber()
  quantity!: number;

  @IsString()
  unit!: string;

  @IsString()
  sourceReference?: string;

  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  sourceDocumentId?: string;

  @IsOptional()
  @IsString()
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  importBatchId?: string;
}

export class ConfirmExtractionDto {
  @IsString()
  documentId!: string;

  @IsArray()
  @ArrayMinSize(1)
  activities!: ParsedActivityDto[];

  @IsOptional()
  @IsString()
  importBatchId?: string;
}
