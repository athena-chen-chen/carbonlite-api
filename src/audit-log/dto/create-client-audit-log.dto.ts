import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateClientAuditLogDto {
  @IsString()
  @MaxLength(120)
  action!: string;

  @IsString()
  @MaxLength(120)
  entityType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  page?: string;
}
