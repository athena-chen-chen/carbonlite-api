import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { assertCanContributeActivityData } from '../../common/permissions/activity-data-permissions';

/** Apply after JWT authentication on tenant resource controllers. */
@Injectable()
export class WorkspaceMutationGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      assertCanContributeActivityData(request.user);
    }
    return true;
  }
}
