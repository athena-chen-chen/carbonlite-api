import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiAuthorizationController } from './ai-authorization.controller';

describe('AiAuthorizationController administrative boundary', () => {
  it('binds every administrative route to JWT and platform-admin guards', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiAuthorizationController)).toEqual([
      JwtAuthGuard,
      PlatformAdminGuard,
    ]);
  });

  it('does not let an ordinary organization user pass the platform-admin boundary', () => {
    const request = {
      user: {
        id: 'ordinary-user',
        organizationId: 'org-a',
        role: 'USER',
        platformRole: 'USER',
        accountType: 'CUSTOMER',
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;

    expect(() => new PlatformAdminGuard().canActivate(context)).toThrow(
      ForbiddenException,
    );
  });
});
