import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class WithdrawAiAuthorizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  withdrawalReference!: string;
}
