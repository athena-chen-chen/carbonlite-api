import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertDocumentSize, hashDocumentFile, MAX_DOCUMENT_UPLOAD_BYTES, readBoundedDocumentFile, validateCsvText, validateDocumentContent, validateDocumentType } from './document-resource-policy';

it('streams exactly the same SHA-256 hex digest as buffered hashing, including multiple read chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f08-hash-test-'));
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 17); for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
    const path = join(directory, 'fixture'); await writeFile(path, buffer);
    expect(await hashDocumentFile(path)).toBe(createHash('sha256').update(buffer).digest('hex'));
    expect((await readBoundedDocumentFile(path)).equals(buffer)).toBe(true);
    await truncate(path, MAX_DOCUMENT_UPLOAD_BYTES + 1);
    await expect(readBoundedDocumentFile(path)).rejects.toThrow('10 MB');
    await expect(hashDocumentFile(path)).rejects.toThrow('10 MB');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('accepts the exact byte limit and rejects the next byte', () => {
  expect(() => assertDocumentSize(MAX_DOCUMENT_UPLOAD_BYTES)).not.toThrow();
  expect(() => assertDocumentSize(MAX_DOCUMENT_UPLOAD_BYTES + 1)).toThrow('10 MB');
});
it('layers extension, meaningful MIME and content validation while allowing browser generic MIME', () => {
  expect(validateDocumentType('BILL.PDF', 'application/octet-stream')).toBe('.pdf');
  expect(validateDocumentType('bill.pdf', 'application/pdf; charset=binary')).toBe('.pdf');
  expect(() => validateDocumentType('bill.exe', 'application/pdf')).toThrow('Unsupported');
  expect(() => validateDocumentType('bill.pdf', 'image/png')).toThrow('Unsupported');
  expect(() => validateDocumentContent('bill.pdf', Buffer.from('MZ executable'))).toThrow('content');
  expect(() => validateDocumentContent('table.xlsx', Buffer.from('text'))).toThrow('content');
});
it('permits normal quoted UTF-8 CSV, including escaped quotes and embedded newlines', () => {
  const text = 'activityType,notes\nDIESEL,"first line\nsecond line, and ""quotation"""\n';
  expect(validateCsvText(Buffer.from(text))).toBe(text);
  expect(() => validateCsvText(Buffer.from('header\n"unclosed'))).toThrow('quoting');
});
