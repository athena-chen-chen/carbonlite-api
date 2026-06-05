import { FeedbackStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateFeedbackStatusDto {
  @IsEnum(FeedbackStatus)
  status!: FeedbackStatus;
}
