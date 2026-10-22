import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.service';
import { assertCanContributeActivityData } from './activity-data-permissions';

/** platformRole is copied from persisted User.role, never from membership. */
export function isPlatformAdmin(user: AuthenticatedUser) {
  return user.platformRole === UserRole.ADMIN && user.accountType !== 'PILOT_REVIEWER';
}

export function isWorkspaceAdmin(user: AuthenticatedUser) {
  if (user.accountType === 'PILOT_REVIEWER' || user.membershipRole === 'VIEWER') return false;
  return user.membershipRole === 'OWNER' || user.membershipRole === 'ADMIN' ||
    (!user.membershipRole && user.role === UserRole.ADMIN);
}

export function assertCanAdministerWorkspace(user: AuthenticatedUser) {
  assertCanContributeActivityData(user);
  if (!isWorkspaceAdmin(user)) throw new ForbiddenException('You do not have permission to manage this workspace.');
}
