import { ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';

export class BulkUpdateProvinceDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];

  @IsString()
  @MaxLength(80)
  province!: string;
}
