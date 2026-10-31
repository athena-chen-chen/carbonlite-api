import { IsDateString, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';

const EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example name@example.com.';

export enum InvitationPurpose {
  DEMO = 'DEMO',
  CUSTOMER = 'CUSTOMER',
}

export class CreatePilotReviewerDto {
  @IsOptional()
  @IsEnum(InvitationPurpose)
  invitationPurpose?: InvitationPurpose;

  @IsString()
  @MinLength(2)
  name!: string;

  @Matches(
    /^\s*(?!.*mailto:)(?!.*@(gamil|gmai|gmial)\.com\s*$)[^\s@()[\]"']+@[^\s@()[\]"']+\.[^\s@()[\]"']+\s*$/i,
    {
    message: EMAIL_VALIDATION_MESSAGE,
    },
  )
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
