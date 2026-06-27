import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { ConversionFactorsService } from './conversion-factors.service';
import { UpdateFactorVersionDraftDto } from './dto/update-factor-version-draft.dto';
import { FactorVersionActionDto } from './dto/factor-version-action.dto';

@UseGuards(JwtAuthGuard)
@Controller('factor-versions')
export class FactorVersionsController {
  constructor(private readonly conversionFactorsService: ConversionFactorsService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversionFactorsService.getFactorVersion(id);
  }


  @Get(':id/usage')
  usage(@Param('id') id: string) {
    return this.conversionFactorsService.getFactorVersionUsage(id);
  }

  @Patch(':id/draft')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  updateDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateFactorVersionDraftDto & { reason?: string },
  ) {
    const { reason, ...data } = dto;
    return this.conversionFactorsService.updateDraftFactorVersion(
      id,
      data,
      reason,
      user.id,
    );
  }

  @Post(':id/verify')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FactorVersionActionDto,
  ) {
    return this.conversionFactorsService.verifyFactor(id, {
      reviewedBy: user.id,
      reviewNotes: dto.reviewNotes ?? dto.reason,
      approvalSource: dto.approvalSource,
    });
  }

  @Post(':id/deprecate')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  deprecate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FactorVersionActionDto,
  ) {
    return this.conversionFactorsService.deprecateFactor(id, dto.reason, user.id);
  }

  @Post(':id/archive')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FactorVersionActionDto,
  ) {
    return this.conversionFactorsService.archiveFactor(id, dto.reason, user.id);
  }
}
