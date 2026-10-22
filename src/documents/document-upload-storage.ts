import { CallHandler, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MULTER_MODULE_OPTIONS } from '@nestjs/platform-express/multer/files.constants';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

type PendingUpload = { paths: Set<string>; writes: Set<Promise<unknown>> };
const pendingUploads = new WeakMap<Request, PendingUpload>();

/** Disk storage with pipeline teardown on truncated streams; bytes never accumulate in RAM. */
export function documentDiskStorage(directory = './uploads', filename = () => randomUUID()): StorageEngine {
  return {
    _handleFile(request, file, callback) {
      const pending = pendingUploads.get(request) ?? { paths: new Set<string>(), writes: new Set<Promise<unknown>>() };
      pendingUploads.set(request, pending);
      const name = filename(); const path = join(directory, name);
      pending.paths.add(path);
      const write = (async () => {
        await mkdir(directory, { recursive: true });
        const output = createWriteStream(path, { flags: 'wx' });
        try {
          await pipeline(file.stream, output);
          return { destination: directory, filename: name, path, size: output.bytesWritten };
        } catch (error) {
          await unlink(path).catch(() => undefined);
          throw error;
        }
      })();
      pending.writes.add(write);
      void write.then(info => callback(null, info), error => callback(error)).finally(() => pending.writes.delete(write));
    },
    _removeFile(_request, file, callback) {
      unlink(file.path).then(() => callback(null), error => callback(error.code === 'ENOENT' ? null : error));
    },
  };
}

@Injectable()
export class DocumentUploadInterceptor extends FileInterceptor('file') {
  constructor(@Optional() @Inject(MULTER_MODULE_OPTIONS) options: MulterOptions = {}) { super(options); }
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    try {
      // This awaits multipart parsing only. Later controller/audit failures retain
      // successfully persisted source documents; their lifecycle is separate.
      const result = await super.intercept(context, next);
      pendingUploads.delete(request);
      return result;
    } catch (error) {
      const pending = pendingUploads.get(request);
      if (pending) {
        await Promise.allSettled([...pending.writes]);
        await Promise.all([...pending.paths].map(path => unlink(path).catch(() => undefined)));
        pendingUploads.delete(request);
      }
      throw error;
    }
  }
}
