import { Body, Controller, Inject, Post } from '@nestjs/common';
import { DocumentExtractionService } from './document-extraction.service';
import { ExtractDocumentDto } from './dto/extract-document.dto';
import { ConfirmExtractionDto } from './dto/confirm-extraction.dto';

@Controller('document-extraction')
export class DocumentExtractionController {
  constructor(
    @Inject(DocumentExtractionService)
    private readonly service: DocumentExtractionService,
  ) {}

  @Post('extract')
  extract(@Body() dto: ExtractDocumentDto) {
    return this.service.extract(dto.documentId);
  }

  @Post('confirm')
  confirm(@Body() dto: ConfirmExtractionDto) {
    return this.service.confirmImport(dto.documentId, dto.activities);
  }
}