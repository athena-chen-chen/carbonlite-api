import { documentUploadOptions } from './document-resource-policy';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RealDataAuthorizationModule } from '../real-data-authorization/real-data-authorization.module';

@Module({
  imports: [
    PrismaModule,
    RealDataAuthorizationModule,
    MulterModule.register(documentUploadOptions),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
