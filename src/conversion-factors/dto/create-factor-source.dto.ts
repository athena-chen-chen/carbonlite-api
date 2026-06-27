import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { PublisherType } from '@prisma/client';

export class CreateFactorSourceDto {
  @IsString()
  @MaxLength(200)
  sourceAuthority!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  sourceShortName?: string;

  @IsString()
  @MaxLength(240)
  sourceDocument!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sourceVersion?: string;

  @IsOptional()
  @IsInt()
  sourceYear?: number;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  sourceUrl?: string;

  @IsOptional()
  @IsISO8601()
  publishedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  jurisdictionRegion?: string;

  @IsOptional()
  @IsEnum(PublisherType)
  publisherType?: PublisherType;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isOfficial?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  tableReference?: string;
}
