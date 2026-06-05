import { FeedbackType } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateFeedbackDto {
  @IsEnum(FeedbackType)
  type!: FeedbackType;

  @IsString()
  @MaxLength(2000)
  intent!: string;

  @IsString()
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  page?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string;
}
