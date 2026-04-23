import { IsArray, IsString, IsNumber } from 'class-validator';

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
}

export class ConfirmExtractionDto {
  @IsString()
  documentId!: string;

  @IsArray()
  activities!: ParsedActivityDto[];
}