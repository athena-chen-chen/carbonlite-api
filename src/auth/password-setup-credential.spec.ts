import {
  createPasswordSetupCredential,
  hashPasswordSetupCredential,
  PASSWORD_SETUP_TTL_HOURS,
} from './password-setup-credential';

describe('password setup credential', () => {
  it('creates the normal finite-expiry hashed setup state', () => {
    const now = new Date('2026-11-16T20:00:00.000Z');
    const credential = createPasswordSetupCredential({
      now,
      randomBytesFn: () => Buffer.alloc(32, 7),
    });

    expect(credential.tokenHash).toBe(
      hashPasswordSetupCredential(credential.token),
    );
    expect(credential.tokenHash).not.toBe(credential.token);
    expect(credential.expiresAt).toEqual(
      new Date(
        now.getTime() + PASSWORD_SETUP_TTL_HOURS * 60 * 60 * 1000,
      ),
    );
  });
});
