import { MembershipRole, UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/auth.service';
import { assertCanAdministerWorkspace, isPlatformAdmin, isWorkspaceAdmin } from './workspace-permissions';
import { PlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
const base: AuthenticatedUser = { id: 'user', email: 'test@example.com', organizationId: 'org', organizationName: 'Org', role: UserRole.USER, platformRole: UserRole.USER, accountType: 'CUSTOMER' };
it.each([MembershipRole.OWNER, MembershipRole.ADMIN])('%s has workspace administration without platform privilege', membershipRole => {
  const user = { ...base, role: UserRole.ADMIN, membershipRole };
  expect(isWorkspaceAdmin(user)).toBe(true);
  expect(() => assertCanAdministerWorkspace(user)).not.toThrow();
  expect(isPlatformAdmin(user)).toBe(false);
  const context = { switchToHttp: () => ({ getRequest: () => ({ user }) }) };
  expect(() => new PlatformAdminGuard().canActivate(context as never)).toThrow('permission');
});
it('requires the raw persisted privilege even if the effective role says ADMIN', () => {
  expect(isPlatformAdmin({ ...base, role: UserRole.ADMIN, platformRole: undefined })).toBe(false);
  expect(isPlatformAdmin({ ...base, role: UserRole.ADMIN, platformRole: UserRole.ADMIN })).toBe(true);
});
it.each([
  { ...base, membershipRole: MembershipRole.VIEWER, role: UserRole.ADMIN, platformRole: UserRole.ADMIN },
  { ...base, membershipRole: MembershipRole.OWNER, role: UserRole.ADMIN, accountType: 'PILOT_REVIEWER' },
  { ...base, membershipRole: MembershipRole.EDITOR },
])('rejects workspace administration without the capability (%j)', user => {
  expect(isWorkspaceAdmin(user)).toBe(false);
  expect(() => assertCanAdministerWorkspace(user)).toThrow();
});
