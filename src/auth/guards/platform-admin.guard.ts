import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isPlatformAdmin } from '../../common/permissions/workspace-permissions';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest().user;
    if (!user || !isPlatformAdmin(user)) throw new ForbiddenException('You do not have permission to access this resource.');
    return true;
  }
}
