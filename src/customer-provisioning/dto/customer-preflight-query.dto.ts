import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CustomerPreflightQueryDto {
  @IsOptional()
  @Transform(({ value }) => String(value).trim().toLowerCase())
  @IsEmail()
  email?: string;

  @IsOptional()
  @Transform(({ value }) => String(value).trim())
  @IsString()
  @MinLength(1)
  organizationName?: string;
}
