// api/src/factors/dto/factor-query.dto.ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsPositive, IsString, Max, Min ,IsEnum} from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ActivityTypeDto } from '../../activity-data/dto/create-activity-data.dto';
import { FactorTypeDto } from './create-conversion-factor.dto';
const SORT_FIELDS = ['updatedAt', 'createdAt', 'year', 'category', 'subCategory'] as const;
type SortField = typeof SORT_FIELDS[number];

export class FactorQueryDto {
  /** 关键词：category / subCategory / source / region / scope 模糊匹配（不区分大小写） */
  @IsOptional() @IsString()
  q?: string;

  /** 年份 */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100)
  year?: number;

  /** 页码（默认 1） */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  /** 每页大小（默认 20，上限 200） */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number = 20;

  /** 排序字段（默认 updatedAt） */
  @IsOptional() @IsIn(SORT_FIELDS as unknown as string[])
  sortBy?: SortField = 'updatedAt';

  /** 排序方向（默认 desc） */
  @IsOptional() @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}


export class ConversionFactorQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(FactorTypeDto)
  type?: FactorTypeDto;

  @IsOptional()
  @IsEnum(ActivityTypeDto)
  activityType?: ActivityTypeDto;

  @IsOptional()
  @IsString()
  search?: string;
}