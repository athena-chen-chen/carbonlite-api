import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ActivateLegalHoldDto } from './dto/activate-legal-hold.dto';
import { ReleaseLegalHoldDto, RequestLegalHoldReleaseDto, ReviewLegalHoldReleaseDto } from './dto/release-legal-hold.dto';
import { LegalHoldsService } from './legal-holds.service';

@Controller('admin/legal-holds')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class LegalHoldsController {
  constructor(private readonly legalHolds: LegalHoldsService) {}

  @Post('activate')
  activate(@CurrentUser() actor: AuthenticatedUser, @Body() dto: ActivateLegalHoldDto) {
    return this.legalHolds.activate(actor, dto);
  }

  @Get('organization/:organizationId')
  list(@Param('organizationId') organizationId: string) {
    return this.legalHolds.list(organizationId);
  }

  @Post(':id/release-request')
  requestRelease(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RequestLegalHoldReleaseDto,
  ) {
    return this.legalHolds.requestRelease(actor, id, dto);
  }

  @Post(':id/release')
  release(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReleaseLegalHoldDto,
  ) {
    return this.legalHolds.release(actor, id, dto);
  }

  @Post(':id/release-review')
  reviewRelease(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewLegalHoldReleaseDto,
  ) {
    return this.legalHolds.reviewRelease(actor, id, dto);
  }
}
