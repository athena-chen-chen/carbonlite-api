import { ConfigService } from '@nestjs/config';

/** Signing and verification require explicit configuration in every environment. */
export function resolveJwtSecret(config: Pick<ConfigService, 'get'>): string {
  const value = config.get<unknown>('JWT_SECRET');
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('JWT_SECRET must be configured with a non-empty value.');
  }
  return value.trim();
}
