import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MembershipRole, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';
import { CreatePilotReviewerDto } from './dto/create-pilot-reviewer.dto';
import { SetPasswordDto } from './dto/set-password.dto';
import {
  GOLDEN_SAMPLE_WORKSPACE_NAME,
  ensureGoldenSampleDataForWorkspace,
} from '../sample-data/golden-sample-data.service';

export type AuthenticatedUser = {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: UserRole;
  accountType?: string | null;
};

type JwtPayload = {
  sub: string;
  email: string;
  organizationId: string;
};

const PILOT_REVIEWER_ACCOUNT_TYPE = 'PILOT_REVIEWER';
const DEFAULT_PILOT_WORKSPACE_NAME = GOLDEN_SAMPLE_WORKSPACE_NAME;
const DEFAULT_INVITE_TTL_HOURS = 48;
const EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example alexander@example.com.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
    let user: Prisma.UserGetPayload<{ include: { organization: true } }> | null;

    try {
      user = await this.prisma.user.findUnique({
        where: { email },
        include: { organization: true },
      });
    } catch (error) {
      if (isDatabaseUnavailableError(error)) {
        const localDemoResponse = await this.tryLocalDemoLogin(email, password);
        if (localDemoResponse) return localDemoResponse;
      }

      throw error;
    }

    if (!user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    this.assertAccountNotExpired(user);

    if (!user.organization) {
      throw new UnauthorizedException(
        'Account setup is incomplete. Please contact an administrator.',
      );
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.recordLoginActivity({
      organizationId: user.organizationId,
      userId: user.id,
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

  async createPilotReviewer(
    currentUser: AuthenticatedUser,
    dto: CreatePilotReviewerDto,
  ) {
    if (currentUser.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to create pilot reviewers.',
      );
    }

    const email = this.normalizePilotReviewerEmail(dto.email);
    const fullName = dto.name.trim();
    const workspaceName =
      dto.workspaceName?.trim() ||
      dto.workspace?.trim() ||
      DEFAULT_PILOT_WORKSPACE_NAME;
    const expiresAt = dto.expiresAt || dto.expires;
    const accountExpiresAt = expiresAt ? new Date(expiresAt) : null;

    if (!fullName) {
      throw new BadRequestException('Pilot reviewer name is required.');
    }

    if (accountExpiresAt && Number.isNaN(accountExpiresAt.getTime())) {
      throw new BadRequestException('Pilot reviewer expiry date is invalid.');
    }

    const inviteToken = randomBytes(32).toString('base64url');
    const inviteTokenHash = this.hashInviteToken(inviteToken);
    const inviteExpiresAt = new Date(
      Date.now() + DEFAULT_INVITE_TTL_HOURS * 60 * 60 * 1000,
    );
    const { firstName, lastName } = this.splitName(fullName);

    const result = await this.prisma.$transaction(async (tx) => {
      const workspace = dto.workspaceId
        ? await tx.organization.findUnique({ where: { id: dto.workspaceId } })
        : await this.findOrCreatePilotWorkspace(tx, workspaceName);

      if (!workspace) {
        throw new BadRequestException('Selected workspace was not found.');
      }

      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser?.role === UserRole.ADMIN) {
        throw new ConflictException(
          'Admin accounts cannot be converted into pilot reviewers.',
        );
      }

      const user = existingUser
        ? await tx.user.update({
            where: { id: existingUser.id },
            data: {
              organizationId: workspace.id,
              firstName,
              lastName,
              role: UserRole.USER,
              accountType: PILOT_REVIEWER_ACCOUNT_TYPE,
              accountExpiresAt,
              passwordHash: null,
              passwordSetupRequired: true,
              passwordSetupTokenHash: inviteTokenHash,
              passwordSetupTokenExpiresAt: inviteExpiresAt,
              passwordSetupTokenUsedAt: null,
              isActive: true,
            },
          })
        : await tx.user.create({
            data: {
              organizationId: workspace.id,
              email,
              firstName,
              lastName,
              role: UserRole.USER,
              accountType: PILOT_REVIEWER_ACCOUNT_TYPE,
              accountExpiresAt,
              passwordSetupRequired: true,
              passwordSetupTokenHash: inviteTokenHash,
              passwordSetupTokenExpiresAt: inviteExpiresAt,
              isActive: true,
            },
          });

      await tx.membership.deleteMany({ where: { userId: user.id } });
      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: workspace.id,
          role: MembershipRole.VIEWER,
        },
      });

      await ensureGoldenSampleDataForWorkspace(tx, workspace.id, {
        createdById: user.id,
      });

      return { user, workspace };
    });

    return {
      success: true,
      pilotReviewer: {
        name: this.formatUserName(result.user.firstName, result.user.lastName),
        email: result.user.email,
        accountType: PILOT_REVIEWER_ACCOUNT_TYPE,
        role: MembershipRole.VIEWER,
        workspaceName: result.workspace.name,
        expiresAt: result.user.accountExpiresAt?.toISOString() ?? null,
      },
      inviteLink: this.buildInviteLink(inviteToken),
    };
  }

  async authenticatePilotReviewerCreator(
    authorizationHeader?: string,
  ): Promise<AuthenticatedUser> {
    const token = this.extractBearerToken(authorizationHeader);
    if (!token) {
      throw new UnauthorizedException(
        'Admin authentication or ADMIN_SCRIPT_TOKEN is required.',
      );
    }

    if (this.isValidAdminScriptToken(token)) {
      return {
        id: 'admin-script',
        email: 'admin-script@carbonlite.local',
        organizationId: 'admin-script',
        organizationName: 'CarbonLite Admin Script',
        role: UserRole.ADMIN,
      };
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      return this.validateJwtPayload(payload);
    } catch {
      throw new UnauthorizedException(
        'Script is not authorized to create pilot reviewers. Check ADMIN_SCRIPT_TOKEN or admin authentication.',
      );
    }
  }

  async setPasswordFromInvite(dto: SetPasswordDto) {
    const tokenHash = this.hashInviteToken(dto.token);
    const now = new Date();

    const user = await this.prisma.user.findFirst({
      where: {
        passwordSetupTokenHash: tokenHash,
        passwordSetupTokenUsedAt: null,
        passwordSetupTokenExpiresAt: { gt: now },
        isActive: true,
      },
      include: { organization: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invite link is invalid or expired.');
    }

    this.assertAccountNotExpired(user);

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordSetupRequired: false,
        passwordSetupTokenHash: null,
        passwordSetupTokenUsedAt: now,
      },
      include: { organization: true },
    });

    return this.buildAuthResponse(updatedUser);
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

    this.assertAccountNotExpired(user);

    return this.toSafeUser(user);
  }

  private async buildAuthResponse(
    user: Prisma.UserGetPayload<{ include: { organization: true } }>,
  ) {
    await this.ensurePilotReviewerSampleData(user);
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

  private async ensurePilotReviewerSampleData(
    user: Prisma.UserGetPayload<{ include: { organization: true } }>,
  ) {
    if (
      user.accountType !== PILOT_REVIEWER_ACCOUNT_TYPE ||
      user.organization?.name !== GOLDEN_SAMPLE_WORKSPACE_NAME
    ) {
      return;
    }

    await ensureGoldenSampleDataForWorkspace(this.prisma, user.organizationId, {
      createdById: user.id,
    });
  }

  private toSafeUser(
    user: Prisma.UserGetPayload<{ include: { organization: true } }>,
  ): AuthenticatedUser {
    if (!user.organization) {
      throw new UnauthorizedException(
        'Account setup is incomplete. Please contact an administrator.',
      );
    }

    return {
      id: user.id,
      email: user.email,
      organizationId: user.organizationId,
      organizationName: user.organization.name,
      role: user.role,
      accountType: user.accountType,
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

  private async findOrCreatePilotWorkspace(
    tx: Prisma.TransactionClient,
    workspaceName: string,
  ) {
    const existing = await tx.organization.findFirst({
      where: { name: workspaceName },
    });
    if (existing) return existing;

    return tx.organization.create({
      data: {
        name: workspaceName,
        slug: await this.createUniqueOrganizationSlug(tx, workspaceName),
        allowDemoFactorsForCalculations: true,
      },
    });
  }

  private buildInviteLink(token: string) {
    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(
      /\/+$/,
      '',
    );

    return `${appUrl}/set-password?token=${encodeURIComponent(token)}`;
  }

  private hashInviteToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private extractBearerToken(authorizationHeader?: string) {
    const [scheme, token] = String(authorizationHeader ?? '').split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return '';
    return token.trim();
  }

  private isValidAdminScriptToken(token: string) {
    const expectedToken = String(
      process.env.ADMIN_SCRIPT_TOKEN ||
        process.env.ADMIN_API_TOKEN ||
        process.env.CARBONLITE_ADMIN_TOKEN ||
        '',
    ).trim();
    if (!expectedToken) return false;

    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expectedToken);
    return (
      tokenBuffer.length === expectedBuffer.length &&
      timingSafeEqual(tokenBuffer, expectedBuffer)
    );
  }

  private splitName(name: string) {
    const [firstName, ...rest] = name.trim().split(/\s+/);
    return {
      firstName,
      lastName: rest.length ? rest.join(' ') : null,
    };
  }

  private formatUserName(firstName?: string | null, lastName?: string | null) {
    return [firstName, lastName].filter(Boolean).join(' ').trim();
  }

  private normalizePilotReviewerEmail(email: string) {
    const normalized = String(email ?? '').trim().toLowerCase();
    if (
      /[\[\]()]|mailto:/i.test(normalized) ||
      !/^[^\s@()[\]]+@[^\s@()[\]]+\.[^\s@()[\]]+$/.test(normalized)
    ) {
      throw new BadRequestException(EMAIL_VALIDATION_MESSAGE);
    }

    return normalized;
  }

  private assertAccountNotExpired(user: { accountExpiresAt?: Date | null }) {
    if (user.accountExpiresAt && user.accountExpiresAt <= new Date()) {
      throw new UnauthorizedException('Account access has expired.');
    }
  }

  private async tryLocalDemoLogin(email: string, password: string) {
    if (process.env.LOCAL_DEMO_AUTH_ENABLED !== 'true') return null;

    const allowedEmails = (process.env.LOCAL_DEMO_EMAILS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const localPassword = process.env.LOCAL_DEMO_PASSWORD;

    if (!localPassword || !allowedEmails.includes(email)) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (password !== localPassword) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const user: AuthenticatedUser = {
      id: process.env.LOCAL_DEMO_USER_ID || 'local-demo-user',
      email,
      organizationId:
        process.env.LOCAL_DEMO_ORGANIZATION_ID || 'local-demo-organization',
      organizationName:
        process.env.LOCAL_DEMO_ORGANIZATION_NAME ||
        'CarbonLite Pilot Demo Workspace',
      role: UserRole.ADMIN,
    };

    await this.recordLoginActivity({
      organizationId: user.organizationId,
      userId: user.id,
    });

    return {
      accessToken: await this.jwt.signAsync({
        sub: user.id,
        email: user.email,
        organizationId: user.organizationId,
      } satisfies JwtPayload),
      user,
      warning:
        'Local demo auth was used because the database is unavailable.',
    };
  }

  private async recordLoginActivity(input: {
    organizationId: string;
    userId: string;
  }) {
    try {
      await this.auditLog.log({
        organizationId: input.organizationId,
        userId: input.userId,
        action: 'LOGIN',
        entityType: 'Authentication',
        entityId: input.userId,
        description: 'User logged in',
      });
    } catch (error) {
      this.logger.warn(
        `Login audit logging failed: ${getErrorMessage(error)}`,
      );
    }

    try {
      await this.activityTracking.track({
        organizationId: input.organizationId,
        userId: input.userId,
        eventName: 'USER_LOGGED_IN',
        entityType: 'User',
        entityId: input.userId,
      });
    } catch (error) {
      this.logger.warn(
        `Login activity tracking failed: ${getErrorMessage(error)}`,
      );
    }
  }
}

function isDatabaseUnavailableError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = getErrorMessage(error).toLowerCase();

  return (
    code === 'P1001' ||
    message.includes("can't reach database server") ||
    message.includes('database server') ||
    message.includes('connection refused') ||
    message.includes('connection terminated')
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
