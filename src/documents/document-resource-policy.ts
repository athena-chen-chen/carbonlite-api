import { documentDiskStorage } from './document-upload-storage';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';

// Match the existing browser contract. Exact 10 MiB files are accepted.
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_UPLOAD = 1;
export const MAX_SPREADSHEET_SHEETS = 20;
export const MAX_SPREADSHEET_ROWS = 10_000; // physical rows, including headers
export const MAX_SPREADSHEET_COLUMNS = 100;
export const MAX_SPREADSHEET_CELLS = 250_000;
export const MAX_EXTRACTED_REVIEW_ROWS = 10_000;
export const MAX_CSV_RECORD_CHARACTERS = 64 * 1024;

const mimeByExtension: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'],
  '.json': ['application/json', 'text/json', 'text/plain'],
};
export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(mimeByExtension);
export const UNSUPPORTED_DOCUMENT_MESSAGE = 'Unsupported file type. Please upload a PDF, CSV, XLSX, XLS, PNG, JPG, or JSON file.';

export function validateDocumentType(fileName: string, mimeType?: string | null) {
  const extension = extname(fileName).toLowerCase();
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!mimeByExtension[extension] || (mime && mime !== 'application/octet-stream' && !mimeByExtension[extension].includes(mime))) {
    throw new BadRequestException(UNSUPPORTED_DOCUMENT_MESSAGE);
  }
  return extension;
}

export const documentUploadOptions: MulterOptions = {
  storage: documentDiskStorage(),
  limits: {
    // Busboy emits its size-limit event on reaching this value, not exceeding it.
    fileSize: MAX_DOCUMENT_UPLOAD_BYTES + 1,
    files: MAX_DOCUMENTS_PER_UPLOAD, fields: 4, parts: 5, fieldSize: 1024,
  },
  fileFilter: (_request, file, callback) => {
    try { validateDocumentType(file.originalname, file.mimetype); callback(null, true); }
    catch (error) { callback(error as Error, false); }
  },
};

export function assertDocumentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new PayloadTooLargeException('File must be 10 MB or less.');
  }
}

export async function readBoundedDocumentFile(path: string) {
  assertDocumentSize((await stat(path)).size);
  // Stored upload files are immutable. Recheck the buffer before any parsing or encoding.
  const buffer = await readFile(path);
  assertDocumentSize(buffer.length);
  return buffer;
}

export async function hashDocumentFile(path: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    assertDocumentSize(bytes);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function assertReviewRowLimit(rows: number) {
  if (rows > MAX_EXTRACTED_REVIEW_ROWS) throw new BadRequestException('File processing limit exceeded: too many activity records.');
}

function decodeText(buffer: Buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new BadRequestException('Invalid text encoding. Please use UTF-8.'); }
}

export function validateCsvText(buffer: Buffer) {
  const text = decodeText(buffer);
  if (text.includes('\0')) throw new BadRequestException('Invalid CSV content.');
  let quoted = false, rows = 1, columns = 1, recordCharacters = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (++recordCharacters > MAX_CSV_RECORD_CHARACTERS) throw new BadRequestException('File processing limit exceeded: CSV record is too long.');
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { i++; recordCharacters++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') {
      if (++columns > MAX_SPREADSHEET_COLUMNS) throw new BadRequestException('File processing limit exceeded: too many CSV columns.');
    } else if (!quoted && character === '\n') {
      if (i + 1 < text.length && ++rows > MAX_SPREADSHEET_ROWS) throw new BadRequestException('File processing limit exceeded: too many CSV rows.');
      columns = 1; recordCharacters = 0;
    }
  }
  if (quoted) throw new BadRequestException('Malformed CSV quoting.');
  return text;
}

export function validateDocumentContent(fileName: string, buffer: Buffer) {
  assertDocumentSize(buffer.length);
  if (!buffer.length) throw new BadRequestException('File is empty.');
  const extension = extname(fileName).toLowerCase();
  const starts = (hex: string) => buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const valid = extension === '.pdf' ? buffer.subarray(0, 5).toString() === '%PDF-' :
    extension === '.png' ? starts('89504e470d0a1a0a') :
    ['.jpg', '.jpeg'].includes(extension) ? starts('ffd8ff') :
    extension === '.xlsx' ? starts('504b0304') :
    extension === '.xls' ? starts('d0cf11e0a1b11ae1') : true;
  if (!valid) throw new BadRequestException('File content does not match its supported file type.');
  if (extension === '.csv') validateCsvText(buffer);
  if (extension === '.json') {
    let payload: any;
    try { payload = JSON.parse(decodeText(buffer)); }
    catch { throw new BadRequestException('Invalid JSON file. Please check the file format and try again.'); }
    const rows = Array.isArray(payload) ? payload : payload?.activityRecords;
    if (Array.isArray(rows)) assertReviewRowLimit(rows.length);
  }
}
