

// api/src/prisma/prisma.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import pkg from '@prisma/client';

// ESM-friendly import for PrismaClient
const { PrismaClient } = pkg as typeof import('@prisma/client');

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (error) {
      this.logger.error(buildDatabaseConnectionErrorMessage(error));
      if (process.env.LOCAL_DEMO_AUTH_ENABLED === 'true') {
        this.logger.warn(
          'Continuing API startup with LOCAL_DEMO_AUTH_ENABLED=true. Database-backed routes may fail until DATABASE_URL is reachable.',
        );
        return;
      }
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

function buildDatabaseConnectionErrorMessage(error: unknown) {
  const databaseUrl = parseDatabaseUrl(process.env.DATABASE_URL);
  const code = getPrismaErrorCode(error);

  return [
    'Database connection failed during startup.',
    code ? `Prisma error code: ${code}.` : null,
    databaseUrl
      ? `DATABASE_URL target: ${databaseUrl.host}:${databaseUrl.port}/${databaseUrl.database}.`
      : 'DATABASE_URL is missing or is not a valid database URL.',
    databaseUrl?.sslmode === 'require'
      ? 'SSL mode: require.'
      : 'SSL mode is not set to require; Neon pooled connections usually require sslmode=require.',
    'Check Neon availability, network access to port 5432, and that DATABASE_URL points to the runtime pooled endpoint.',
  ]
    .filter(Boolean)
    .join(' ');
}

function getPrismaErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : null;
}

function parseDatabaseUrl(value?: string) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || '(missing)',
      sslmode: url.searchParams.get('sslmode'),
    };
  } catch {
    return null;
  }
}
