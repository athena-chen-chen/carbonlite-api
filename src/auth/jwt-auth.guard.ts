import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable, tap } from 'rxjs';
import { AuthenticatedUser } from './auth.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const result = super.canActivate(context);

    if (result instanceof Promise) {
      return result.then((allowed) => {
        this.enforcePilotReviewerReadOnly(context);
        return allowed;
      });
    }

    if (result instanceof Observable) {
      return result.pipe(
        tap(() => {
          this.enforcePilotReviewerReadOnly(context);
        }),
      );
    }

    this.enforcePilotReviewerReadOnly(context);
    return result as boolean;
  }

  private enforcePilotReviewerReadOnly(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      method: string;
      path?: string;
      route?: { path?: string };
      user?: AuthenticatedUser;
    }>();

    if (request.user?.accountType !== 'PILOT_REVIEWER') return;

    const method = request.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;

    const path = request.path || request.route?.path || '';
    const allowedWritePaths = [
      '/api/feedback',
      '/feedback',
      '/api/auth/logout',
      '/auth/logout',
    ];
    if (allowedWritePaths.some((allowedPath) => path.startsWith(allowedPath))) {
      return;
    }

    if (path.includes('/factors') || path.includes('/conversion-factors')) {
      throw new ForbiddenException(
        'Pilot reviewer accounts are read-only and cannot modify emission factors.',
      );
    }

    throw new ForbiddenException(
      'Pilot reviewer accounts are read-only for sample data.',
    );
  }
}
