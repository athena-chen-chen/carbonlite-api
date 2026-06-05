import { Injectable, NotFoundException } from '@nestjs/common';
import { FeedbackStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackQueryDto } from './dto/feedback-query.dto';
import { ActivityTrackingService } from '../activity-tracking/activity-tracking.service';

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityTracking: ActivityTrackingService,
  ) {}

  async create(
    organizationId: string,
    dto: CreateFeedbackDto,
    userAgent?: string,
    userId?: string,
  ) {
    const created = await this.prisma.feedback.create({
      data: {
        organizationId,
        type: dto.type,
        intent: dto.intent.trim(),
        message: dto.message.trim(),
        email: dto.email?.trim() || null,
        page: dto.page?.trim() || null,
        url: dto.url?.trim() || null,
        userAgent: userAgent?.trim() || null,
        status: FeedbackStatus.NEW,
      },
    });

    await this.activityTracking.track({
      organizationId,
      userId,
      eventName: 'FEEDBACK_SUBMITTED',
      page: created.page,
      url: created.url,
      entityType: 'Feedback',
      entityId: created.id,
      metadata: {
        type: created.type,
      },
      userAgent,
    });

    return created;
  }

  async findAll(organizationId: string, query: FeedbackQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.FeedbackWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async updateStatus(
    organizationId: string,
    id: string,
    status: FeedbackStatus,
  ) {
    const result = await this.prisma.feedback.updateMany({
      where: { id, organizationId },
      data: { status },
    });

    if (result.count === 0) {
      throw new NotFoundException(`Feedback ${id} not found.`);
    }

    return this.prisma.feedback.findFirst({
      where: { id, organizationId },
    });
  }
}
