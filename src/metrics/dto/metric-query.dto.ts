import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MetricTypeDto } from './calculate-metrics.dto';

export class MetricQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsEnum(MetricTypeDto)
  metricType?: MetricTypeDto;

  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;
}