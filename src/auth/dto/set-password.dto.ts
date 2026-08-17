import { IsString, MinLength } from 'class-validator';

export class SetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
