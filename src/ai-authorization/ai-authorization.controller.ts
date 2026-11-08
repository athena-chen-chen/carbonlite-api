import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiAuthorizationService } from './ai-authorization.service';
import { RecordAiAuthorizationDto } from './dto/record-ai-authorization.dto';
import { WithdrawAiAuthorizationDto } from './dto/withdraw-ai-authorization.dto';

@Controller('admin/organizations/:organizationId/ai-authorization')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AiAuthorizationController {
  constructor(private readonly authorizations: AiAuthorizationService) {}

  @Get()
  get(@Param('organizationId') organizationId: string) {
    return this.authorizations.getForAdmin(organizationId);
  }

  @Put()
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Body() dto: RecordAiAuthorizationDto,
  ) {
    return this.authorizations.recordDecision(organizationId, user.id, dto);
  }

  @Post('withdraw')
  withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Body() dto: WithdrawAiAuthorizationDto,
  ) {
    return this.authorizations.withdraw(
      organizationId,
      user.id,
      dto.withdrawalReference,
    );
  }
}
