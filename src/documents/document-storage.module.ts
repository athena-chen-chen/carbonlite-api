import { Global, Module } from '@nestjs/common';
import { DOCUMENT_STORAGE } from './document-storage';
import { FilesystemDocumentStorage } from './filesystem-document-storage';

@Global()
@Module({
  providers: [
    FilesystemDocumentStorage,
    { provide: DOCUMENT_STORAGE, useExisting: FilesystemDocumentStorage },
  ],
  exports: [DOCUMENT_STORAGE],
})
export class DocumentStorageModule {}
