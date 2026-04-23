import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  Req,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MinLength, IsIn } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(6) password!: string;
}

class RegisterDto extends LoginDto {
  @IsOptional()
  @IsIn(['ADMIN', 'DATA_ENTRY'])
  role?: 'ADMIN' | 'DATA_ENTRY';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // @Post('login')
  // async login(@Body() dto: LoginDto) {
  //   return this.auth.login(dto.email, dto.password);
  // }

  // // dev-only, keep or later guard behind ADMIN / remove
  // @Post('register')
  // async register(@Body() dto: RegisterDto) {
  //   const role = dto.role ?? 'ADMIN';
  //   return this.auth.register(dto.email, dto.password, role);
  // }

  // @UseGuards(JwtAuthGuard)
  // @Get('me')
  // me(@Req() req: any) {
  //   // whatever JwtStrategy puts into req.user
  //   return req.user;
  // }
}
