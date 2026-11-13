import {
  Equals,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ApproveRealDataAuthorizationDto {
  @IsString()
  @MinLength(1)
  organizationId!: string;

  @IsString()
  @MinLength(1)
  confirmationOrganizationId!: string;

  @IsString()
  @MinLength(1)
  confirmationOrganizationSlug!: string;

  @IsBoolean()
  @Equals(true)
  confirmRealDataApproval!: true;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  policyVersion!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  agreementEvidenceReference!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  allowedDataScopeReference!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  privacySecurityReadinessReference!: string;

  @IsDateString()
  effectiveAt!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsDateString()
  reviewDueAt?: string;
}
