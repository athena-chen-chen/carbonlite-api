import { createHmac, timingSafeEqual } from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  codedServiceUnavailable,
  REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION_ENV,
  REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS_ENV,
  REAL_DATA_EVIDENCE_HMAC_KEYRING_ENV,
} from './real-data-authorization.constants';

type Environment = Record<string, string | undefined>;

export type EvidenceSigner = {
  hmacKeyVersion: string;
  digest(value: string): string;
};

export type EvidenceHmacConfigurationSummary = {
  activeVersion: string;
  versions: string[];
  loadedKeyCount: number;
  legacySourcePresent: boolean;
  additiveSourcePresent: boolean;
};

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_PREFIX = 'base64:';
const MINIMUM_KEY_BYTES = 32;

export class RealDataEvidenceHmacKeyring {
  constructor(private readonly environment: Environment = process.env) {}

  activeSigner(): EvidenceSigner {
    const { activeVersion, keys } = this.readConfiguration();
    return this.createSigner(activeVersion, keys.get(activeVersion));
  }

  retainedSigners(): EvidenceSigner[] {
    const { keys } = this.readConfiguration();
    return [...keys.entries()].map(([version, key]) =>
      this.createSigner(version, key),
    );
  }

  configurationSummary(): EvidenceHmacConfigurationSummary {
    const configuration = this.readConfiguration();
    return {
      activeVersion: configuration.activeVersion,
      versions: [...configuration.keys.keys()].sort(),
      loadedKeyCount: configuration.keys.size,
      legacySourcePresent: configuration.legacySourcePresent,
      additiveSourcePresent: configuration.additiveSourcePresent,
    };
  }

  signerForVersion(hmacKeyVersion: string): EvidenceSigner {
    const { keys } = this.readConfiguration();
    const key = keys.get(hmacKeyVersion);
    if (!key) throw this.historicalKeyUnavailable();
    return this.createSigner(hmacKeyVersion, key);
  }

  verify(hmacKeyVersion: string, value: string, expectedHash: string): boolean {
    const { keys } = this.readConfiguration();
    const key = keys.get(hmacKeyVersion);
    if (!key) throw this.historicalKeyUnavailable();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
    const actual = Buffer.from(this.digest(key, value), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private readConfiguration() {
    const activeVersion = this.normalizeVersion(
      this.environment[REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION_ENV],
    );
    const serializedLegacyKeyring =
      this.environment[REAL_DATA_EVIDENCE_HMAC_KEYRING_ENV];
    const serializedAdditionalKeys =
      this.environment[REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS_ENV];
    const legacySourcePresent = serializedLegacyKeyring !== undefined;
    const additiveSourcePresent = serializedAdditionalKeys !== undefined;
    const keys = new Map<string, Buffer>();
    if (legacySourcePresent) {
      this.addLegacyKeys(keys, serializedLegacyKeyring);
    }
    if (additiveSourcePresent) {
      this.addAdditionalKeys(keys, serializedAdditionalKeys);
    }
    if (keys.size === 0 || !keys.has(activeVersion)) {
      throw this.configurationUnavailable();
    }
    return {
      activeVersion,
      keys,
      legacySourcePresent,
      additiveSourcePresent,
    };
  }

  private addLegacyKeys(keys: Map<string, Buffer>, serialized: string) {
    const parsed = this.parseJson(serialized);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw this.configurationUnavailable();
    }
    for (const value of parsed) {
      if (!this.isStrictEntry(value)) throw this.configurationUnavailable();
      this.addKey(keys, this.normalizeVersion(value.version), value.key);
    }
  }

  private addAdditionalKeys(keys: Map<string, Buffer>, serialized: string) {
    const parsed = this.parseJson(serialized);
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || Object.keys(parsed).length === 0
      || this.hasDuplicateJsonObjectKeys(serialized)
    ) {
      throw this.configurationUnavailable();
    }
    for (const [rawVersion, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') throw this.configurationUnavailable();
      this.addKey(keys, this.normalizeVersion(rawVersion), value);
    }
  }

  private parseJson(serialized: string): unknown {
    if (!serialized.trim()) throw this.configurationUnavailable();
    try {
      return JSON.parse(serialized);
    } catch {
      throw this.configurationUnavailable();
    }
  }

  private hasDuplicateJsonObjectKeys(serialized: string) {
    const rawKeys = [...serialized.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)]
      .map(match => JSON.parse(`"${match[1]}"`) as string);
    return new Set(rawKeys).size !== rawKeys.length;
  }

  private addKey(keys: Map<string, Buffer>, version: string, serializedKey: string) {
    if (keys.has(version)) throw this.configurationUnavailable();
    keys.set(version, this.decodeKey(serializedKey));
  }

  private normalizeVersion(value: string | undefined) {
    const normalized = value?.trim();
    if (!normalized || !VERSION_PATTERN.test(normalized)) {
      throw this.configurationUnavailable();
    }
    return normalized;
  }

  private isStrictEntry(value: unknown): value is { version: string; key: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    const fields = Object.keys(entry).sort();
    return fields.length === 2
      && fields[0] === 'key'
      && fields[1] === 'version'
      && typeof entry.version === 'string'
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

  private createSigner(hmacKeyVersion: string, key: Buffer | undefined): EvidenceSigner {
    if (!key) throw this.configurationUnavailable();
    return {
      hmacKeyVersion,
      digest: (value: string) => this.digest(key, value),
    };
  }

  private historicalKeyUnavailable() {
    return new ServiceUnavailableException(
      codedServiceUnavailable(
        'REAL_DATA_EVIDENCE_HISTORICAL_KEY_UNAVAILABLE',
        'Historical real-data authorization evidence cannot currently be verified.',
      ),
    );
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
