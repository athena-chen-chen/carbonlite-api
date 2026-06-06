import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

export type AuthenticatedUser = {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: UserRole;
};

type JwtPayload = {
  sub: string;
  email: string;
  organizationId: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const organizationName = dto.organizationName.trim();
    const passwordHash = await bcrypt.hash(dto.password, 10);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: organizationName,
            slug: await this.createUniqueOrganizationSlug(tx, organizationName),
          },
        });

        return tx.user.create({
          data: {
            email,
            passwordHash,
            organizationId: organization.id,
            role: UserRole.USER,
          },
          include: {
            organization: true,
          },
        });
      });

      await this.activityTracking.track({
        organizationId: user.organizationId,
        userId: user.id,
        eventName: 'USER_REGISTERED',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          organizationId: user.organizationId,
        },
      });

      return this.buildAuthResponse(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email is already registered.');
      }

      throw error;
    }
  }

  async login(emailInput: string, password: string) {
    const email = emailInput.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { organization: true },
    });

    if (!user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.auditLog.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'LOGIN',
      entityType: 'Authentication',
      entityId: user.id,
      description: 'User logged in',
    });

    await this.activityTracking.track({
      organizationId: user.organizationId,
      userId: user.id,
      eventName: 'USER_LOGGED_IN',
      entityType: 'User',
      entityId: user.id,
    });

    return this.buildAuthResponse(user);
  }

  async logout(user: AuthenticatedUser) {
    await this.auditLog.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: 'LOGOUT',
      entityType: 'Authentication',
      entityId: user.id,
      description: 'User logged out',
    });

    await this.activityTracking.track({
      organizationId: user.organizationId,
      userId: user.id,
      eventName: 'USER_LOGGED_OUT',
      entityType: 'User',
      entityId: user.id,
    });

    return { loggedOut: true };
  }

  async validateJwtPayload(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        organizationId: payload.organizationId,
        isActive: true,
      },
      include: { organization: true },
    });

    if (!user) {
      throw new UnauthorizedException('Unauthorized request.');
    }

    return this.toSafeUser(user);
  }

  private async buildAuthResponse(
    user: Prisma.UserGetPayload<{ include: { organization: true } }>,
  ) {
    const safeUser = this.toSafeUser(user);

    return {
      accessToken: await this.jwt.signAsync({
        sub: safeUser.id,
        email: safeUser.email,
        organizationId: safeUser.organizationId,
      } satisfies JwtPayload),
      user: safeUser,
    };
  }

  private toSafeUser(
    user: Prisma.UserGetPayload<{ include: { organization: true } }>,
  ): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      role: user.role,
    };
  }

  private async createUniqueOrganizationSlug(
    tx: Prisma.TransactionClient,
    name: string,
  ) {
    const baseSlug =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'organization';

    let slug = baseSlug;
    let suffix = 1;

    while (await tx.organization.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }

    return slug;
  }
}
