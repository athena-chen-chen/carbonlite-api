import { Transform } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class BulkUpdateFacilityDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  ids!: string[];

  @Transform(({ value }) => String(value ?? '').trim())
  @IsString()
  @IsNotEmpty({ message: 'Facility name is required.' })
  @MaxLength(200)
  facilityName!: string;
}
