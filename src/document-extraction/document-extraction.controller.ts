import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { DocumentExtractionService } from './document-extraction.service';
import { ExtractDocumentDto } from './dto/extract-document.dto';
import { ConfirmExtractionDto } from './dto/confirm-extraction.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('document-extraction')
export class DocumentExtractionController {
  constructor(
    @Inject(DocumentExtractionService)
    private readonly service: DocumentExtractionService,
  ) {}

  @Post('extract')
  extract(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExtractDocumentDto) {
    return this.service.extract(user.organizationId, dto.documentId);
  }

  @Post('confirm')
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmExtractionDto,
  ) {
    return this.service.confirmImport(
      user.organizationId,
      dto.documentId,
      dto.activities,
    );
  }
}
