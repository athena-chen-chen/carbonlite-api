import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateActivityDataDto } from './create-activity-data.dto';

export class BulkImportActivityDataDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateActivityDataDto)
  items!: CreateActivityDataDto[];
}