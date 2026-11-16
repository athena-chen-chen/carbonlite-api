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

const additionalEnvironment = (
  activeVersion = 'rc-v1',
  entries: Record<string, string> = { 'rc-v1': encodedKey(6) },
) => ({
  REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: activeVersion,
  REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: JSON.stringify(entries),
});

function expectConfigurationInvalid(environment: Record<string, string | undefined>) {
  let thrown: unknown;
  try {
    new RealDataEvidenceHmacKeyring(environment).activeSigner();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ServiceUnavailableException);
  expect(thrown).toMatchObject({
    response: expect.objectContaining({
      code: 'REAL_DATA_EVIDENCE_CONFIGURATION_INVALID',
    }),
  });
  expect(JSON.stringify(thrown)).not.toContain(encodedKey(1));
  expect(JSON.stringify(thrown)).not.toContain(encodedKey(6));
}

describe('RealDataEvidenceHmacKeyring', () => {
  it('loads a legacy-only v1/v2 keyring, verifies both versions, and signs with v2', () => {
    const environment = configuredEnvironment('v2');
    const keyring = new RealDataEvidenceHmacKeyring(environment);
    const v1Hash = keyring.signerForVersion('v1').digest('org-a');
    const v2Hash = keyring.signerForVersion('v2').digest('org-a');

    expect(keyring.activeSigner().hmacKeyVersion).toBe('v2');
    expect(keyring.activeSigner().digest('org-a')).toBe(v2Hash);
    expect(keyring.verify('v1', 'org-a', v1Hash)).toBe(true);
    expect(keyring.verify('v2', 'org-a', v2Hash)).toBe(true);
  });

  it('loads a clean additive-only RC signer without legacy keys', () => {
    const keyring = new RealDataEvidenceHmacKeyring(additionalEnvironment());
    const signer = keyring.activeSigner();
    const hash = signer.digest('org-a');

    expect(signer.hmacKeyVersion).toBe('rc-v1');
    expect(keyring.verify('rc-v1', 'org-a', hash)).toBe(true);
    expect(keyring.configurationSummary()).toEqual({
      activeVersion: 'rc-v1',
      versions: ['rc-v1'],
      loadedKeyCount: 1,
      legacySourcePresent: false,
      additiveSourcePresent: true,
    });
  });

  it('merges legacy v1/v2 with additive v6 and signs only with explicit active v6', () => {
    const environment = {
      ...configuredEnvironment('v6'),
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: JSON.stringify({
        v6: encodedKey(6),
      }),
    };
    const keyring = new RealDataEvidenceHmacKeyring(environment);
    const historicalV1 = keyring.signerForVersion('v1').digest('org-a');
    const historicalV2 = keyring.signerForVersion('v2').digest('org-a');
    const current = keyring.activeSigner();

    expect(current.hmacKeyVersion).toBe('v6');
    expect(keyring.verify('v1', 'org-a', historicalV1)).toBe(true);
    expect(keyring.verify('v2', 'org-a', historicalV2)).toBe(true);
    expect(current.digest('org-a')).not.toBe(historicalV1);
    expect(current.digest('org-a')).not.toBe(historicalV2);
    expect(keyring.configurationSummary()).toEqual({
      activeVersion: 'v6',
      versions: ['v1', 'v2', 'v6'],
      loadedKeyCount: 3,
      legacySourcePresent: true,
      additiveSourcePresent: true,
    });
  });

  it('fails closed when the historical version is no longer in the keyring', () => {
    const environment = configuredEnvironment('v2', [
      { version: 'v2', key: encodedKey(2) },
    ]);
    const keyring = new RealDataEvidenceHmacKeyring(environment);
    expect(() => keyring.verify('v1', 'org-a', '0'.repeat(64))).toThrow(
      ServiceUnavailableException,
    );
    expect(() => keyring.signerForVersion('v1')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('enumerates version-specific signers without exposing key material', () => {
    const keyring = new RealDataEvidenceHmacKeyring(configuredEnvironment());
    const signers = keyring.retainedSigners();

    expect(signers.map(signer => signer.hmacKeyVersion)).toEqual(['v1', 'v2']);
    expect(signers[0].digest('org-a')).toBe(
      keyring.signerForVersion('v1').digest('org-a'),
    );
    expect(JSON.stringify(signers)).not.toContain(encodedKey(1));
    expect(JSON.stringify(signers)).not.toContain(encodedKey(2));
  });

  it.each([
    ['missing active version', {
      REAL_DATA_EVIDENCE_HMAC_KEYRING: JSON.stringify([
        { version: 'v1', key: encodedKey(1) },
      ]),
    }],
    ['malformed legacy keyring', {
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
    ['malformed additive JSON', {
      REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: 'rc-v1',
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: '{not-json',
    }],
    ['empty additive map', {
      REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: 'rc-v1',
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: '{}',
    }],
    ['invalid additive Base64', additionalEnvironment('rc-v1', {
      'rc-v1': 'base64:not-valid***',
    })],
    ['non-canonical additive Base64', additionalEnvironment('rc-v1', {
      'rc-v1': `base64:${Buffer.alloc(32, 6).toString('base64').replace(/=$/, '')}`,
    })],
    ['short additive key', additionalEnvironment('rc-v1', {
      'rc-v1': `base64:${Buffer.alloc(31, 6).toString('base64')}`,
    })],
    ['unknown additive active version', additionalEnvironment('rc-v2')],
    ['blank additive version', additionalEnvironment('rc-v1', {
      '   ': encodedKey(6),
    })],
    ['duplicate additive JSON property', {
      REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION: 'rc-v1',
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS:
        `{"rc-v1":"${encodedKey(6)}","rc-v1":"${encodedKey(7)}"}`,
    }],
  ])('rejects %s without exposing configuration material', (_label, environment) => {
    expectConfigurationInvalid(environment);
  });

  it('rejects a version defined in both legacy and additive sources', () => {
    expectConfigurationInvalid({
      ...configuredEnvironment('v2'),
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: JSON.stringify({
        v2: encodedKey(6),
      }),
    });
  });

  it('rejects an entirely missing configuration', () => {
    expectConfigurationInvalid({});
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

  it('never includes encoded key material in safe configuration diagnostics', () => {
    const environment = {
      ...configuredEnvironment('v6'),
      REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS: JSON.stringify({ v6: encodedKey(6) }),
    };
    const summary = new RealDataEvidenceHmacKeyring(environment).configurationSummary();

    expect(JSON.stringify(summary)).not.toContain(encodedKey(1));
    expect(JSON.stringify(summary)).not.toContain(encodedKey(6));
  });
});
