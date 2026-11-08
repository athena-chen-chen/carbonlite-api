import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { isApprovedNonProductionRuntime } from './security-policy';

type RateLimitPolicy = {
  path: string;
  windowMs: number;
  limit: number;
};

const MINUTE_MS = 60_000;

export function configureHttpSecurity(
  app: NestExpressApplication,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const corsAllowedOrigins = resolveCorsAllowedOrigins(environment);
  const trustProxyHops = resolveTrustProxyHops(environment);

  app.use(helmet());
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.enableCors({
    origin: corsAllowedOrigins,
    credentials: true,
  });

  for (const policy of resolveRateLimitPolicies(environment)) {
    app.use(
      policy.path,
      rateLimit({
        windowMs: policy.windowMs,
        limit: policy.limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {
          statusCode: 429,
          message: 'Too many requests. Please try again later.',
          error: 'Too Many Requests',
        },
      }),
    );
  }
}

export function resolveTrustProxyHops(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(environment.TRUST_PROXY_HOPS || '').trim();

  if (!configured) {
    if (!isApprovedNonProductionRuntime(environment)) {
      throw new Error(
        'TRUST_PROXY_HOPS is required outside explicit local/development/test runtimes and must match the deployment proxy chain.',
      );
    }
    return 0;
  }

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
  }
  return parsed;
}

export function resolveCorsAllowedOrigins(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(environment.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (
    configured.length === 0 &&
    !isApprovedNonProductionRuntime(environment)
  ) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS is required outside explicit local/development/test runtimes and must contain explicit origins.',
    );
  }

  if (configured.some(origin => !isExplicitHttpOrigin(origin))) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain only explicit HTTP(S) origins.',
    );
  }

  return configured.length > 0 ? configured : ['http://localhost:5173'];
}

function isExplicitHttpOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function resolveRateLimitPolicies(
  environment: NodeJS.ProcessEnv = process.env,
): RateLimitPolicy[] {
  return [
    policy('/api/auth/login', 15, 10, 'LOGIN_RATE_LIMIT'),
    policy('/api/auth/register', 60, 3, 'REGISTRATION_RATE_LIMIT'),
    policy('/api/auth/set-password', 15, 5, 'PASSWORD_SETUP_RATE_LIMIT'),
    policy(
      '/api/auth/password-reset/confirm',
      15,
      5,
      'PASSWORD_SETUP_RATE_LIMIT',
    ),
    policy('/api/documents/upload', 60, 20, 'DOCUMENT_UPLOAD_RATE_LIMIT'),
    policy(
      '/api/document-extraction/extract',
      60,
      10,
      'AI_EXTRACTION_RATE_LIMIT',
    ),
  ].map(item => ({
    path: item.path,
    windowMs: item.windowMs,
    limit: positiveInteger(environment[item.environmentKey], item.limit),
  }));
}

function policy(
  path: string,
  windowMinutes: number,
  limit: number,
  environmentKey: string,
) {
  return {
    path,
    windowMs: windowMinutes * MINUTE_MS,
    limit,
    environmentKey,
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
