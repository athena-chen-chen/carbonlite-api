import { Module } from '@nestjs/common';
import { DocumentExtractionController } from './document-extraction.controller';
import { DocumentExtractionService } from './document-extraction.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DocumentExtractionController],
  providers: [DocumentExtractionService],
})
export class DocumentExtractionModule {}