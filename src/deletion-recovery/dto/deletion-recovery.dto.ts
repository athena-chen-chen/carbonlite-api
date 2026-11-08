import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class StorageReconciliationDto {
  @IsOptional()
  @IsString()
  organizationId?: string;
}

export class PurgeDryRunDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  candidateIds!: string[];
}

export class ExecutePurgeDto extends PurgeDryRunDto {
  @IsString()
  reviewToken!: string;

  @IsBoolean()
  confirmPurge!: boolean;
}
