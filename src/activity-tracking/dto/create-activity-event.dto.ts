import { IsObject, IsOptional, IsString } from 'class-validator';

export class CreateActivityEventDto {
  @IsString()
  eventName!: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
