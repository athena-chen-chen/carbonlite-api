import { ArrayUnique, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ActivateLegalHoldDto {
  @IsString()
  organizationId!: string;

  @IsString()
  @MaxLength(120)
  caseReference!: string;

  @IsIn(['ORGANIZATION', 'DOCUMENT'])
  scopeType!: 'ORGANIZATION' | 'DOCUMENT';

  @IsOptional()
  @IsIn(['PROVISIONAL', 'ACTIVE'])
  status?: 'PROVISIONAL' | 'ACTIVE';

  @IsString()
  @MaxLength(200)
  authorityReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  evidenceReference?: string;

  @IsString()
  requesterUserId!: string;

  @IsString()
  approvedByUserId!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  documentIds?: string[];

  @IsOptional()
  @IsDateString()
  nextReviewAt?: string;
}
