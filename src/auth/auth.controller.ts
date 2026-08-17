import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedUser, AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { SetPasswordDto } from './dto/set-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('set-password')
  setPassword(@Body() dto: SetPasswordDto) {
    return this.auth.setPasswordFromInvite(dto);
  }

  @Post('password-reset/confirm')
  confirmPasswordReset(@Body() dto: SetPasswordDto) {
    return this.auth.setPasswordFromInvite(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logout(user);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
