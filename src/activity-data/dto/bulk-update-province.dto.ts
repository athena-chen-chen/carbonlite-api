import { Transform } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsString } from 'class-validator';

export const PILOT_PROVINCE_CODES = ['AB', 'BC', 'ON'] as const;

export class BulkUpdateProvinceDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];

  @Transform(({ value }) => String(value ?? '').trim().toUpperCase())
  @IsString()
  @IsIn(PILOT_PROVINCE_CODES, {
    message: 'Unsupported province code: $value',
  })
  province!: string;
}
