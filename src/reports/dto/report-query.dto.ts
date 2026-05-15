import { ReportStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ReportQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsEnum(ReportStatus)
  status?: ReportStatus;
}
