import { createHmac, timingSafeEqual } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  codedServiceUnavailable,
  REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION_ENV,
  REAL_DATA_EVIDENCE_HMAC_KEYRING_ENV,
} from './real-data-authorization.constants';

type Environment = Record<string, string | undefined>;

export type EvidenceSigner = {
  hmacKeyVersion: string;
  digest(value: string): string;
};

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_PREFIX = 'base64:';
const MINIMUM_KEY_BYTES = 32;

export class RealDataEvidenceHmacKeyring {
  constructor(private readonly environment: Environment = process.env) {}

  activeSigner(): EvidenceSigner {
    const { activeVersion, keys } = this.readConfiguration();
    const key = keys.get(activeVersion);
    if (!key) throw this.configurationUnavailable();
    return {
      hmacKeyVersion: activeVersion,
      digest: (value: string) => this.digest(key, value),
    };
  }

  verify(hmacKeyVersion: string, value: string, expectedHash: string): boolean {
    const { keys } = this.readConfiguration();
    const key = keys.get(hmacKeyVersion);
    if (!key) {
      throw new ServiceUnavailableException(
        codedServiceUnavailable(
          'REAL_DATA_EVIDENCE_HISTORICAL_KEY_UNAVAILABLE',
          'Historical real-data authorization evidence cannot currently be verified.',
        ),
      );
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
    const actual = Buffer.from(this.digest(key, value), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private readConfiguration() {
    const activeVersion = this.environment[
      REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION_ENV
    ]?.trim();
    const serializedKeyring = this.environment[
      REAL_DATA_EVIDENCE_HMAC_KEYRING_ENV
    ];
    if (!activeVersion || !VERSION_PATTERN.test(activeVersion) || !serializedKeyring) {
      throw this.configurationUnavailable();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedKeyring);
    } catch {
      throw this.configurationUnavailable();
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw this.configurationUnavailable();
    }

    const keys = new Map<string, Buffer>();
    for (const value of parsed) {
      if (!this.isStrictEntry(value) || keys.has(value.version)) {
        throw this.configurationUnavailable();
      }
      keys.set(value.version, this.decodeKey(value.key));
    }
    if (!keys.has(activeVersion)) throw this.configurationUnavailable();
    return { activeVersion, keys };
  }

  private isStrictEntry(value: unknown): value is { version: string; key: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    const fields = Object.keys(entry).sort();
    return fields.length === 2
      && fields[0] === 'key'
      && fields[1] === 'version'
      && typeof entry.version === 'string'
      && VERSION_PATTERN.test(entry.version)
      && typeof entry.key === 'string';
  }

  private decodeKey(serialized: string) {
    if (!serialized.startsWith(BASE64_PREFIX)) {
      throw this.configurationUnavailable();
    }
    const encoded = serialized.slice(BASE64_PREFIX.length);
    if (!BASE64_PATTERN.test(encoded)) throw this.configurationUnavailable();
    const key = Buffer.from(encoded, 'base64');
    if (
      key.length < MINIMUM_KEY_BYTES
      || key.toString('base64') !== encoded
    ) {
      throw this.configurationUnavailable();
    }
    return key;
  }

  private digest(key: Buffer, value: string) {
    return createHmac('sha256', key).update(value, 'utf8').digest('hex');
  }

  private configurationUnavailable() {
    return new ServiceUnavailableException(
      codedServiceUnavailable(
        'REAL_DATA_EVIDENCE_CONFIGURATION_INVALID',
        'Real-data evidence protection is unavailable.',
      ),
    );
  }
}
