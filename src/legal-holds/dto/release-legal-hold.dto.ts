import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestLegalHoldReleaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  evidenceReference?: string;
}

export class ReviewLegalHoldReleaseDto {
  @IsString()
  @MaxLength(200)
  authorityReference!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  evidenceReference?: string;
}

export class ReleaseLegalHoldDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  evidenceReference?: string;
}
