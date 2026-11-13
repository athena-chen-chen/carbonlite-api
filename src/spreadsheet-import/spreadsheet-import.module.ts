import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SpreadsheetImportController } from './spreadsheet-import.controller';
import { SpreadsheetImportService } from './spreadsheet-import.service';
import { RealDataAuthorizationModule } from '../real-data-authorization/real-data-authorization.module';

@Module({
  imports: [PrismaModule, RealDataAuthorizationModule],
  controllers: [SpreadsheetImportController],
  providers: [SpreadsheetImportService],
})
export class SpreadsheetImportModule {}
