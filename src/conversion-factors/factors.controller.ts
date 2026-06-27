import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { FactorsService } from './factors.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { ConversionFactorsService } from './conversion-factors.service';
import { CreateFactorVersionDto } from './dto/create-factor-version.dto';

@UseGuards(JwtAuthGuard)
@Controller('factors')
export class FactorsController {
  constructor(
    private readonly factorsService: FactorsService,
    private readonly conversionFactorsService: ConversionFactorsService,
  ) {}

  @Get()
  findAll(@Query() query: { includeArchived?: string }) {
    return this.factorsService.findAll(query);
  }


  @Get(':id/versions')
  findVersions(
    @Param('id') id: string,
    @Query() query: { includeArchived?: string },
  ) {
    return this.conversionFactorsService.getFactorVersions(
      id,
      query.includeArchived !== 'false',
    );
  }

  @Post(':id/versions')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateFactorVersionDto & { reason?: string },
  ) {
    const { reason, ...data } = dto;
    return this.conversionFactorsService.createNewFactorVersion(
      id,
      data,
      reason,
      user.id,
    );
  }

  @Get(':id/history')
  findHistory(@Param('id') id: string) {
    return this.conversionFactorsService.getFactorHistory(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.factorsService.findOne(id);
  }
}
