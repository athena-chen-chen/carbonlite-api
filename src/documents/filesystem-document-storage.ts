import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  DocumentStorage,
  DocumentStorageDeleteResult,
  DocumentStorageNotFoundError,
  ManagedStorageEntry,
  documentQuarantineKey,
  documentStorageKey,
} from './document-storage';
import { isApprovedNonProductionRuntime } from '../common/security/security-policy';

export type DocumentStorageEnvironment = Record<string, string | undefined>;
export const DOCUMENT_STORAGE_ENVIRONMENT = Symbol('DOCUMENT_STORAGE_ENVIRONMENT');

export function resolveDocumentStorageConfiguration(
  environment: DocumentStorageEnvironment = process.env,
) {
  const runtime = [environment.APP_ENV, environment.NODE_ENV]
    .map(value => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join('/') || 'unspecified';
  const requiresDurableStorage = !isApprovedNonProductionRuntime(environment);
  const configuredPath = String(environment.DOCUMENT_STORAGE_PATH || '').trim();
  const durable = String(environment.DOCUMENT_STORAGE_DURABLE || '').trim().toLowerCase() === 'true';

  if (requiresDurableStorage && (!configuredPath || !durable)) {
    throw new Error(
      'Durable document storage is required in deployed environments. Set DOCUMENT_STORAGE_PATH and DOCUMENT_STORAGE_DURABLE=true.',
    );
  }

  return {
    rootPath: resolve(configuredPath || './uploads'),
    durable: requiresDurableStorage ? durable : durable || Boolean(configuredPath),
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
    const destination = await this.resolveActiveKey(storageKey, true);
    const temporary = `${destination}.pending-${randomUUID()}`;
    await this.createSecureDirectory(dirname(destination));
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
      return await readFile(await this.resolveActiveKey(storageKey, false));
    } catch (error) {
      if (this.isMissing(error)) throw new DocumentStorageNotFoundError(storageKey);
      throw error;
    }
  }

  async quarantine(storageKey: string, intentId: string) {
    const source = await this.resolveActiveKey(storageKey, true);
    const quarantineKey = documentQuarantineKey(intentId, storageKey);
    const destination = await this.resolveQuarantineKey(quarantineKey, true);
    await this.createSecureDirectory(dirname(destination));

    const [sourceExists, destinationExists] = await Promise.all([
      this.pathExists(source),
      this.pathExists(destination),
    ]);
    if (sourceExists && destinationExists) {
      throw new Error('Active and quarantine copies both exist; reconciliation is required.');
    }
    if (!sourceExists && destinationExists) {
      await this.assertRegularManagedFile(destination);
      return { result: 'ALREADY_QUARANTINED' as const, quarantineKey };
    }
    if (!sourceExists) return { result: 'NOT_FOUND' as const, quarantineKey };
    await this.assertRegularManagedFile(source);
    await rename(source, destination);
    return { result: 'MOVED' as const, quarantineKey };
  }

  async quarantineExists(quarantineKey: string) {
    const path = await this.resolveQuarantineKey(quarantineKey, true);
    return this.pathExists(path);
  }

  async purgeQuarantine(quarantineKey: string): Promise<DocumentStorageDeleteResult> {
    const path = await this.resolveQuarantineKey(quarantineKey, true);
    try {
      await this.assertRegularManagedFile(path);
      await unlink(path);
      return 'DELETED';
    } catch (error) {
      if (this.isMissing(error)) return 'NOT_FOUND';
      throw error;
    }
  }

  async listActive() {
    return this.listTree(this.rootPath, false);
  }

  async listQuarantine() {
    const root = resolve(this.rootPath, '.quarantine');
    if (!(await this.pathExists(root))) return [];
    return this.listTree(root, true);
  }

  async exists(storageKey: string) {
    try {
      await access(await this.resolveActiveKey(storageKey, false), constants.R_OK);
      return true;
    } catch (error) {
      if (this.isMissing(error)) return false;
      throw error;
    }
  }

  async delete(storageKey: string): Promise<DocumentStorageDeleteResult> {
    try {
      await unlink(await this.resolveActiveKey(storageKey, false));
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

  private async resolveActiveKey(storageKey: string, allowMissing: boolean) {
    const key = documentStorageKey(storageKey);
    if (key === '.quarantine' || key.startsWith('.quarantine/')) {
      throw new Error('Quarantine storage is not available through active document operations.');
    }
    const path = this.resolveKey(key);
    await this.assertSecurePath(path, allowMissing);
    return path;
  }

  private async resolveQuarantineKey(quarantineKey: string, allowMissing: boolean) {
    const key = documentStorageKey(quarantineKey);
    if (!/^\.quarantine\/[A-Za-z0-9_-]+\/[^/]+$/.test(key)) {
      throw new Error('Invalid quarantine storage key.');
    }
    const path = this.resolveKey(key);
    await this.assertSecurePath(path, allowMissing);
    return path;
  }

  private async assertSecurePath(path: string, allowMissing: boolean) {
    const rootReal = await realpath(this.rootPath).catch(() => this.rootPath);
    const relativePath = relative(this.rootPath, path);
    let current = this.rootPath;
    for (const segment of relativePath.split(sep)) {
      current = resolve(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in document storage paths.');
      } catch (error) {
        if (this.isMissing(error) && allowMissing) break;
        throw error;
      }
    }
    const existingParent = await this.nearestExistingParent(dirname(path));
    const parentReal = await realpath(existingParent);
    const within = relative(rootReal, parentReal);
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error('Document storage path escapes the managed root.');
    }
  }

  private async nearestExistingParent(path: string): Promise<string> {
    let current = path;
    while (!(await this.pathExists(current))) {
      const parent = dirname(current);
      if (parent === current) throw new Error('Document storage root is unavailable.');
      current = parent;
    }
    return current;
  }

  private async createSecureDirectory(path: string) {
    await mkdir(path, { recursive: true });
    await this.assertSecurePath(path, false);
  }

  private async assertRegularManagedFile(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Managed storage entry is not a regular file.');
    }
  }

  private async pathExists(path: string) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (this.isMissing(error)) return false;
      throw error;
    }
  }

  private async listTree(root: string, quarantine: boolean): Promise<ManagedStorageEntry[]> {
    const entries: ManagedStorageEntry[] = [];
    const visit = async (directory: string) => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        if (!quarantine && (child.name === '.quarantine' || child.name === '.health')) continue;
        const path = resolve(directory, child.name);
        if (child.isSymbolicLink()) throw new Error('Symbolic links are not allowed in document storage.');
        if (child.isDirectory()) await visit(path);
        else if (child.isFile()) {
          const info = await stat(path);
          entries.push({ storageKey: relative(this.rootPath, path), modifiedAt: info.mtime });
        }
      }
    };
    await visit(root);
    return entries;
  }

  private isMissing(error: unknown) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}
