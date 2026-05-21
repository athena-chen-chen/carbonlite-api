import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { access } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async upload(
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
    type?: string,
  ) {
    const created = await this.prisma.document.create({
      data: {
        organizationId,
        uploadedById: userId,
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        mimeType: file.mimetype,
        fileSize: file.size,
        type: (type as any) ?? 'OTHER',
        status: 'UPLOADED',
      },
    });

    return created;
  }

  async findAll(organizationId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where = {
      organizationId,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getDownloadFile(organizationId: string, id: string) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        fileName: true,
        fileUrl: true,
        mimeType: true,
      },
    });

    if (!document) {
      throw new NotFoundException(`Document ${id} not found.`);
    }

    if (document.organizationId !== organizationId) {
      throw new ForbiddenException('You cannot view this document.');
    }

    const relativePath = document.fileUrl.replace(/^\/+/, '');
    const absolutePath = join(process.cwd(), relativePath);

    try {
      await access(absolutePath);
    } catch {
      throw new NotFoundException(
        'Uploaded file is no longer available on the server.',
      );
    }

    return {
      fileName: document.fileName,
      mimeType: document.mimeType || 'application/octet-stream',
      absolutePath,
    };
  }

  async remove(organizationId: string, id: string) {
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
      },
    });

    if (!document) {
      throw new NotFoundException(`Document ${id} not found.`);
    }

    if (document.organizationId !== organizationId) {
      throw new ForbiddenException('You cannot delete this document.');
    }

    await this.prisma.document.delete({
      where: { id },
    });
  }
}
