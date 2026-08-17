import { IsDateString, IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

const EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example alexander@example.com.';

export class CreatePilotReviewerDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail({}, { message: EMAIL_VALIDATION_MESSAGE })
  @Matches(/^(?!.*mailto:)[^\s@()[\]]+@[^\s@()[\]]+\.[^\s@()[\]]+$/i, {
    message: EMAIL_VALIDATION_MESSAGE,
  })
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  workspaceName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  workspace?: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsDateString()
  expires?: string | null;
}
