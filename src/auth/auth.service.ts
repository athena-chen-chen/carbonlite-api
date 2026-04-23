// api/src/auth/auth.service.ts
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    // EXPLICIT TOKENS: no more relying on reflection metadata
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {
    console.log(
      '[AuthService] constructed, prisma =',
      !!this.prisma,
      'jwt =',
      !!this.jwt,
    );
  }

  // private async validateUser(email: string, password: string) {
  //   const user = await this.prisma.user.findUnique({ where: { email } });
  //   if (!user) return null;

  //   const ok = await bcrypt.compare(password, user.passwordHash);
  //   if (!ok) return null;

  //   const { passwordHash, ...safe } = user;
  //   return safe;
  // }

  // async login(email: string, password: string) {
  //   console.log('[AuthService] login', email);
  //   const user = await this.validateUser(email, password);
  //   if (!user) {
  //     throw new UnauthorizedException('Invalid credentials');
  //   }
  //   const payload = { sub: user.id, email: user.email, role: user.role };
  //   return { access_token: await this.jwt.signAsync(payload) };
  // }

  // async register(
  //   email: string,
  //   password: string,
  //   role: 'ADMIN' | 'DATA_ENTRY' = 'DATA_ENTRY',
  // ) {
  //   console.log('[AuthService] register', email, role);
  //   const hash = await bcrypt.hash(password, 10);

  //   return this.prisma.user.create({
  //     data: {
  //       email,
  //       passwordHash: hash,
  //       role,
  //     },
  //     select: { id: true, email: true, role: true },
  //   });
  // }
}
