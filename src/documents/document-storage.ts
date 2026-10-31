import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export type DocumentStorageDeleteResult = 'DELETED' | 'NOT_FOUND';

export interface DocumentStorage {
  save(storageKey: string, contents: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<DocumentStorageDeleteResult>;
  verifyHealth(): Promise<void>;
}

export class DocumentStorageNotFoundError extends Error {
  constructor(readonly storageKey: string) {
    super('Document source evidence was not found in storage.');
    this.name = 'DocumentStorageNotFoundError';
  }
}

export function createDocumentStorageKey(organizationId: string, fileName: string) {
  const extension = extname(fileName).toLowerCase();
  return `${organizationId}/${randomUUID()}${extension}`;
}

/** Converts legacy `/uploads/<key>` values and new opaque keys to one storage key. */
export function documentStorageKey(fileUrl: string) {
  return String(fileUrl ?? '').replace(/^\/+/, '').replace(/^uploads\//, '');
}

export function persistedDocumentStorageUrl(storageKey: string) {
  return `/uploads/${documentStorageKey(storageKey)}`;
}
