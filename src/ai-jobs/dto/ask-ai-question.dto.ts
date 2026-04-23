import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AskAiQuestionDto {
  @IsString()
  @MaxLength(1000)
  question!: string;

  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;
}