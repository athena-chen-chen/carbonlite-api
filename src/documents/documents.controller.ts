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
  Headers,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import { Response } from 'express';
import { DocumentsService } from './documents.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { throwCapturedAppError } from '../common/monitoring/capture-app-error';

@UseGuards(JwtAuthGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DocumentsService)
    private readonly documentsService: DocumentsService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('type') type: string,
    @Body('allowDuplicate') allowDuplicate?: string,
  ) {
    if (!file) {
      throw new BadRequestException('File is required.');
    }

    try {
      return await this.documentsService.upload(
        user.organizationId,
        user.id,
        file,
        type,
        allowDuplicate === 'true',
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'documents',
          operation: 'upload',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'Document',
          metadata: {
            route: '/api/documents/upload',
            method: 'POST',
            mimeType: file.mimetype,
            fileSize: file.size,
            documentType: type,
          },
        },
        'Document upload failed. Please try again.',
      );
    }
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
    @Headers('user-agent') userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let file;
    try {
      file = await this.documentsService.getDownloadFile(
        user.organizationId,
        id,
        user.id,
        userAgent,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'documents',
          operation: 'download',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'Document',
          entityId: id,
          metadata: {
            route: '/api/documents/:id/download',
            method: 'GET',
          },
        },
        'Document could not be opened. Please try again.',
      );
    }

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
    try {
      return await this.documentsService.remove(
        user.organizationId,
        id,
        user.id,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'documents',
          operation: 'delete',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'Document',
          entityId: id,
          metadata: {
            route: '/api/documents/:id',
            method: 'DELETE',
          },
        },
        'Document deletion failed. Please try again.',
      );
    }
  }

  private escapeFileName(fileName: string) {
    return fileName.replace(/["\\]/g, '_');
  }
}
