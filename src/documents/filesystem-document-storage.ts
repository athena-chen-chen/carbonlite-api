import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  DocumentStorage,
  DocumentStorageDeleteResult,
  DocumentStorageNotFoundError,
  documentStorageKey,
} from './document-storage';

export type DocumentStorageEnvironment = Record<string, string | undefined>;
export const DOCUMENT_STORAGE_ENVIRONMENT = Symbol('DOCUMENT_STORAGE_ENVIRONMENT');

export function resolveDocumentStorageConfiguration(
  environment: DocumentStorageEnvironment = process.env,
) {
  const runtime = String(environment.APP_ENV || environment.NODE_ENV || 'development')
    .trim().toLowerCase();
  const deployed = runtime === 'production' || runtime === 'paid-pilot' || runtime === 'pilot';
  const configuredPath = String(environment.DOCUMENT_STORAGE_PATH || '').trim();
  const durable = String(environment.DOCUMENT_STORAGE_DURABLE || '').trim().toLowerCase() === 'true';

  if (deployed && (!configuredPath || !durable)) {
    throw new Error(
      'Durable document storage is required in deployed environments. Set DOCUMENT_STORAGE_PATH and DOCUMENT_STORAGE_DURABLE=true.',
    );
  }

  return {
    rootPath: resolve(configuredPath || './uploads'),
    durable: deployed ? durable : durable || Boolean(configuredPath),
    runtime,
  };
}

@Injectable()
export class FilesystemDocumentStorage implements DocumentStorage, OnModuleInit {
  private readonly logger = new Logger(FilesystemDocumentStorage.name);
  readonly rootPath: string;

  constructor(
    @Optional() @Inject(DOCUMENT_STORAGE_ENVIRONMENT)
    environment?: DocumentStorageEnvironment,
  ) {
    this.rootPath = resolveDocumentStorageConfiguration(environment ?? process.env).rootPath;
  }

  async onModuleInit() {
    await this.verifyHealth();
    this.logger.log(`Document storage ready at ${this.rootPath}`);
  }

  async save(storageKey: string, contents: Buffer) {
    const destination = this.resolveKey(storageKey);
    const temporary = `${destination}.pending-${randomUUID()}`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await writeFile(temporary, contents, { flag: 'wx' });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async read(storageKey: string) {
    try {
      return await readFile(this.resolveKey(storageKey));
    } catch (error) {
      if (this.isMissing(error)) throw new DocumentStorageNotFoundError(storageKey);
      throw error;
    }
  }

  async exists(storageKey: string) {
    try {
      await access(this.resolveKey(storageKey), constants.R_OK);
      return true;
    } catch (error) {
      if (this.isMissing(error)) return false;
      throw error;
    }
  }

  async delete(storageKey: string): Promise<DocumentStorageDeleteResult> {
    try {
      await unlink(this.resolveKey(storageKey));
      return 'DELETED';
    } catch (error) {
      if (this.isMissing(error)) return 'NOT_FOUND';
      throw error;
    }
  }

  async verifyHealth() {
    await mkdir(this.rootPath, { recursive: true });
    await access(this.rootPath, constants.R_OK | constants.W_OK);
    const key = `.health/${randomUUID()}`;
    const marker = Buffer.from(randomUUID());
    await this.save(key, marker);
    let stored: Buffer;
    try {
      stored = await this.read(key);
    } catch (error) {
      await this.delete(key).catch(() => undefined);
      throw error;
    }
    const deleted = await this.delete(key);
    if (!stored.equals(marker)) throw new Error('Document storage health check read mismatch.');
    if (deleted !== 'DELETED') throw new Error('Document storage health check cleanup failed.');
  }

  private resolveKey(storageKey: string) {
    const key = documentStorageKey(storageKey);
    if (!key || isAbsolute(key)) throw new Error('Invalid document storage key.');
    const path = resolve(this.rootPath, key);
    const withinRoot = relative(this.rootPath, path);
    if (!withinRoot || withinRoot.startsWith('..') || isAbsolute(withinRoot)) {
      throw new Error('Invalid document storage key.');
    }
    return path;
  }

  private isMissing(error: unknown) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}
