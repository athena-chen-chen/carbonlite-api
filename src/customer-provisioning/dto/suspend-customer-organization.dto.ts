import { Equals, IsBoolean, IsString, MinLength } from 'class-validator';

export class SuspendCustomerOrganizationDto {
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
  confirmSuspend!: true;
}
