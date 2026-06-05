import { FeedbackStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class FeedbackQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;
}
