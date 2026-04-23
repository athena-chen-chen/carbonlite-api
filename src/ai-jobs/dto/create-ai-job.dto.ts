import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum AIJobTypeDto {
  EXTRACT_ACTIVITY_DATA = 'EXTRACT_ACTIVITY_DATA',
  GENERATE_REPORT_SUMMARY = 'GENERATE_REPORT_SUMMARY',
  ASK_DATA_QUESTION = 'ASK_DATA_QUESTION',
}

export class CreateAIJobDto {
  @IsEnum(AIJobTypeDto)
  jobType!: AIJobTypeDto;

  @IsOptional()
  @IsString()
  reportId?: string;

  @IsOptional()
  @IsString()
  documentId?: string;

  @IsOptional()
  prompt?: string;
}