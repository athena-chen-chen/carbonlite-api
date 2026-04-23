import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ActivityTypeDto } from './create-activity-data.dto';

export class ActivityDataQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsEnum(ActivityTypeDto)
  activityType?: ActivityTypeDto;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  search?: string;
}