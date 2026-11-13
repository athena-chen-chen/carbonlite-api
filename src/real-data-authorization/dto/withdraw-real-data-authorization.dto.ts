import { Equals, IsBoolean, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class WithdrawRealDataAuthorizationDto {
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
  confirmWithdrawal!: true;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  withdrawalReason!: string;
}
