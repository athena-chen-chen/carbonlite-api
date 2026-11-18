import { CalculationModule } from '../metrics/calculation.module';
import { RealDataAuthorizationModule } from '../real-data-authorization/real-data-authorization.module';
import { Module } from '@nestjs/common';
import { DocumentExtractionController } from './document-extraction.controller';
import { DocumentExtractionService } from './document-extraction.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AiAuthorizationModule } from '../ai-authorization/ai-authorization.module';

@Module({
  imports: [PrismaModule, CalculationModule, AiAuthorizationModule, RealDataAuthorizationModule],
  controllers: [DocumentExtractionController],
  providers: [DocumentExtractionService],
})
export class DocumentExtractionModule {}
