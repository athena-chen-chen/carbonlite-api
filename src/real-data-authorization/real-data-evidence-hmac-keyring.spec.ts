import { ServiceUnavailableException } from '@nestjs/common';
import { RealDataEvidenceHmacKeyring } from './real-data-evidence-hmac-keyring';

const encodedKey = (byte: number) =>
  `base64:${Buffer.alloc(32, byte).toString('base64')}`;

const configuredEnvironment = (
  activeVersion = 'v1',
  entries = [
    { version: 'v1', key: encodedKey(1) },
    { version: 'v2', key: encodedKey(2) },
  ],
) => ({
  REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: activeVersion,
  REAL_DATA_EVIDENCE_HMAC_KEYRING: JSON.stringify(entries),
});

describe('RealDataEvidenceHmacKeyring', () => {
  it('records the active version and rotates new hashes without rewriting old hashes', () => {
    const environment = configuredEnvironment();
    const keyring = new RealDataEvidenceHmacKeyring(environment);
    const first = keyring.activeSigner();
    const historicalHash = first.digest('org-a');
    expect(first.hmacKeyVersion).toBe('v1');

    environment.REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION = 'v2';
    const second = keyring.activeSigner();
    expect(second.hmacKeyVersion).toBe('v2');
    expect(second.digest('org-a')).not.toBe(historicalHash);
    expect(keyring.verify('v1', 'org-a', historicalHash)).toBe(true);
    expect(keyring.verify('v2', 'org-a', historicalHash)).toBe(false);
  });

  it('fails closed when the historical version is no longer in the keyring', () => {
    const environment = configuredEnvironment('v2', [
      { version: 'v2', key: encodedKey(2) },
    ]);
    const keyring = new RealDataEvidenceHmacKeyring(environment);
    expect(() => keyring.verify('v1', 'org-a', '0'.repeat(64))).toThrow(
      ServiceUnavailableException,
    );
  });

  it.each([
    ['missing active version', { REAL_DATA_EVIDENCE_HMAC_KEYRING: '[]' }],
    ['malformed keyring', {
      REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: 'v1',
      REAL_DATA_EVIDENCE_HMAC_KEYRING: 'not-json',
    }],
    ['unknown active version', configuredEnvironment('v3')],
    ['duplicate version', configuredEnvironment('v1', [
      { version: 'v1', key: encodedKey(1) },
      { version: 'v1', key: encodedKey(2) },
    ])],
    ['human-readable password', configuredEnvironment('v1', [
      { version: 'v1', key: 'this-is-not-random-key-material' },
    ])],
    ['short decoded key', configuredEnvironment('v1', [
      { version: 'v1', key: `base64:${Buffer.alloc(31, 1).toString('base64')}` },
    ])],
    ['unexpected entry field', configuredEnvironment('v1', [
      { version: 'v1', key: encodedKey(1), label: 'do-not-accept' } as never,
    ])],
  ])('rejects %s without exposing configuration material', (_label, environment) => {
    const serialized = JSON.stringify(environment);
    let thrown: unknown;
    try {
      new RealDataEvidenceHmacKeyring(environment).activeSigner();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(thrown)).not.toContain(serialized);
    expect(JSON.stringify(thrown)).not.toContain(encodedKey(1));
  });

  it('keeps Preview and Production hashes independent by design', () => {
    const preview = new RealDataEvidenceHmacKeyring(configuredEnvironment('preview-v1', [
      { version: 'preview-v1', key: encodedKey(3) },
    ]));
    const production = new RealDataEvidenceHmacKeyring(configuredEnvironment('production-v1', [
      { version: 'production-v1', key: encodedKey(4) },
    ]));
    expect(preview.activeSigner().digest('same-organization')).not.toBe(
      production.activeSigner().digest('same-organization'),
    );
  });
});
