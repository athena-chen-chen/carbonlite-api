import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SpreadsheetImportController } from './spreadsheet-import.controller';
import { SpreadsheetImportService } from './spreadsheet-import.service';

@Module({
  imports: [PrismaModule],
  controllers: [SpreadsheetImportController],
  providers: [SpreadsheetImportService],
})
export class SpreadsheetImportModule {}
