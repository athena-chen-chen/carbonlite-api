import { Allow, IsOptional, IsString } from 'class-validator';

export class JsonActivityDataPreviewDto {
  @IsOptional()
  @IsString()
  jsonContent?: string;

  @IsOptional()
  @Allow()
  data?: unknown;

  @IsOptional()
  @IsString()
  sourceFileName?: string;
}
