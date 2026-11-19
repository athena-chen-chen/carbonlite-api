import { prototypePoolConfiguration } from '../prisma/control-pool.configuration';
import { ControlDatabaseService } from '../prisma/control-database.service';
import { resolveJwtSecret } from './jwt-config';
import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly authService: AuthService,
    configService: ConfigService,
    @Optional() private readonly control?: ControlDatabaseService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: resolveJwtSecret(configService),
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    organizationId: string;
  }) {
    if (!this.control && prototypePoolConfiguration()) throw new ServiceUnavailableException('Control Pool provider is required in prototype mode.');
    if (this.control?.isControlRequest()) {
      return this.control.authenticate(tx => this.authService.validateJwtPayload(payload, tx));
    }
    return this.authService.validateJwtPayload(payload);
  }
}
