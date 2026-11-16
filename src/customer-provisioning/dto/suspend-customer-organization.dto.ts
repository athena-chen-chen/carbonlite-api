import {
  Equals,
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'suspensionReason must contain non-whitespace characters',
  })
  @MaxLength(500)
  suspensionReason!: string;

  @IsBoolean()
  @Equals(true)
  confirmSuspend!: true;
}
