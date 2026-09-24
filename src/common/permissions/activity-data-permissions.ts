import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/auth.service';

export function assertCanContributeActivityData(
  user: AuthenticatedUser,
  deniedMessage = 'Your current role does not allow importing activity data.',
) {
  const accountType = String(user.accountType ?? 'CUSTOMER').trim().toUpperCase();

  if (accountType === 'PILOT_REVIEWER') {
    throw new ForbiddenException('Pilot reviewer accounts are read-only for sample data.');
  }

  if (!user.organizationId) {
    throw new ForbiddenException('Your account is not connected to a workspace.');
  }

  if (accountType !== 'CUSTOMER' && accountType !== 'INTERNAL_TEST') {
    throw new ForbiddenException(deniedMessage);
  }

  const role = String(user.role ?? '').trim().toUpperCase();
  const membershipRole = String(user.membershipRole ?? '').trim().toUpperCase();
  if (
    role === 'VIEWER' ||
    role === 'REVIEWER' ||
    membershipRole === 'VIEWER' ||
    membershipRole === 'REVIEWER'
  ) {
    throw new ForbiddenException(deniedMessage);
  }

  if (!['OWNER', 'ADMIN', 'EDITOR', 'MEMBER', 'USER'].includes(role)) {
    throw new ForbiddenException(deniedMessage);
  }
}
