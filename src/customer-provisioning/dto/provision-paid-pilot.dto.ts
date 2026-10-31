import { Equals, IsBoolean, IsString, MinLength } from 'class-validator';

export class ProvisionPaidPilotDto {
  @IsString()
  @MinLength(1)
  organizationId!: string;

  @IsString()
  @MinLength(1)
  confirmationOrganizationId!: string;

  @IsString()
  @MinLength(1)
  confirmationOrganizationSlug!: string;

  @IsString()
  @MinLength(1)
  primaryAdminUserId!: string;

  @IsBoolean()
  @Equals(true)
  confirmProvision!: true;
}
