import { createHash, randomBytes } from 'node:crypto';

export const PASSWORD_SETUP_TOKEN_BYTES = 32;
export const PASSWORD_SETUP_TTL_HOURS = 48;

type PasswordSetupCredentialOptions = {
  now?: Date;
  randomBytesFn?: typeof randomBytes;
};

export function hashPasswordSetupCredential(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createPasswordSetupCredential(
  options: PasswordSetupCredentialOptions = {},
) {
  const now = options.now ?? new Date();
  const token = (options.randomBytesFn ?? randomBytes)(
    PASSWORD_SETUP_TOKEN_BYTES,
  ).toString('base64url');

  return {
    token,
    tokenHash: hashPasswordSetupCredential(token),
    expiresAt: new Date(
      now.getTime() + PASSWORD_SETUP_TTL_HOURS * 60 * 60 * 1000,
    ),
  };
}
