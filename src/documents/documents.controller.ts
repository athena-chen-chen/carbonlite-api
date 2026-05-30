import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  Body,
  BadRequestException,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import { Response } from 'express';
import { DocumentsService } from './documents.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DocumentsService)
    private readonly documentsService: DocumentsService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: string,
  ) {
    if (!file) {
      throw new BadRequestException('File is required.');
    }

    return this.documentsService.upload(user.organizationId, user.id, file, type);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.documentsService.findAll(user.organizationId, query);
  }

  @Get(':id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.documentsService.getDownloadFile(
      user.organizationId,
      id,
    );

    response.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `inline; filename="${this.escapeFileName(file.fileName)}"`,
    });

    // TODO: Long-term production storage should use S3/Supabase Storage instead of local Render disk.
    return new StreamableFile(createReadStream(file.absolutePath));
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.documentsService.remove(user.organizationId, id);
  }

  private escapeFileName(fileName: string) {
    return fileName.replace(/["\\]/g, '_');
  }
}
