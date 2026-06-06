import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { CreateClientAuditLogDto } from './dto/create-client-audit-log.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AuditLogQueryDto,
  ) {
    return this.auditLogService.findAll(user.organizationId, query);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.auditLogService.findOne(user.organizationId, id);
  }

  @Post('client-event')
  createClientEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateClientAuditLogDto,
    @Req() request: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.auditLogService.log({
      organizationId: user.organizationId,
      userId: user.id,
      action: dto.action,
      entityType: dto.entityType,
      entityId: dto.entityId,
      description: dto.description,
      page: dto.page,
      ipAddress: request.ip,
      userAgent,
    });
  }
}
