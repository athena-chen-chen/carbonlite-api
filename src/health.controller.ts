import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from './prisma/prisma.service';

// URL/driver timeouts do not guarantee a short end-to-end probe deadline.
export const HEALTH_DATABASE_TIMEOUT_MS = 3000;
type DatabaseStatus = 'ok' | 'unavailable';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private databaseCheck?: Promise<DatabaseStatus>;

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getHealth() {
    return {
      status: 'ok',
      service: 'carbonlite-api',
      environment: process.env.APP_ENV || process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
      database: await this.getDatabaseStatus(),
    };
  }

  @Get('live')
  getLiveness(@Req() request?: Request) {
    if (process.env.PROXY_DIAGNOSTICS_ENABLED === 'true' && request) {
      this.logger.log(
        JSON.stringify({
          event: 'proxy_diagnostics',
          socketRemoteAddress: request.socket.remoteAddress,
          xForwardedFor: request.headers['x-forwarded-for'],
          cfConnectingIp: request.headers['cf-connecting-ip'],
          cfRay: request.headers['cf-ray'],
          requestIp: request.ip,
          requestIps: request.ips,
          trustProxyHops: process.env.TRUST_PROXY_HOPS,
        }),
      );
    }
    return { status: 'ok' };
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    const database = await this.getDatabaseStatus();
    const ready = database === 'ok';
    // Expected probe failures bypass exception logging/Sentry, with no raw error.
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks: { database } };
  }

  private async getDatabaseStatus(): Promise<DatabaseStatus> {
    // A response deadline cannot cancel Prisma. Share an outstanding query so
    // repeated timed-out probes cannot accumulate queries/pool waiters.
    if (!this.databaseCheck) {
      this.databaseCheck = Promise.resolve()
        .then(() => this.prisma.$queryRaw`SELECT 1`)
        .then((): DatabaseStatus => 'ok', (): DatabaseStatus => 'unavailable')
        .finally(() => { this.databaseCheck = undefined; });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.databaseCheck,
        new Promise<DatabaseStatus>(resolve => {
          timer = setTimeout(() => resolve('unavailable'), HEALTH_DATABASE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
