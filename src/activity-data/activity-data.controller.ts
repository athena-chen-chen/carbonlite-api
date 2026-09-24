import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActivityDataService } from './activity-data.service';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import { UpdateActivityDataDto } from './dto/update-activity-data.dto';
import { ActivityDataQueryDto } from './dto/activity-data-query.dto';
import { BulkImportActivityDataDto } from './dto/bulk-import-activity-data.dto';
import { BulkDeleteActivityDataDto } from './dto/bulk-delete-activity-data.dto';
import { BulkUpdateProvinceDto } from './dto/bulk-update-province.dto';
import { JsonActivityDataPreviewDto } from './dto/json-activity-data-preview.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { assertCanContributeActivityData } from '../common/permissions/activity-data-permissions';

@UseGuards(JwtAuthGuard)
@Controller('activity-data')
export class ActivityDataController {
  constructor(
    @Inject(ActivityDataService)
    private readonly activityDataService: ActivityDataService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateActivityDataDto) {
    assertCanContributeActivityData(user);

    return this.activityDataService.create(user.organizationId, dto, user.id);
  }

  @Post('bulk-import')
  bulkImport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkImportActivityDataDto,
  ) {
    assertCanContributeActivityData(user);

    return this.activityDataService.bulkImport(user.organizationId, dto, user.id);
  }

  @Post('json-preview')
  previewJsonImport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: JsonActivityDataPreviewDto,
  ) {
    assertCanContributeActivityData(user);

    return this.activityDataService.previewJsonImport(user.organizationId, dto);
  }

  @Post('bulk-delete')
  @HttpCode(200)
  bulkDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkDeleteActivityDataDto,
  ) {
    return this.activityDataService.bulkDelete(user.organizationId, dto.ids, user.id);
  }

  @Delete('bulk-delete')
  @HttpCode(200)
  bulkDeleteWithDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkDeleteActivityDataDto,
  ) {
    return this.activityDataService.bulkDelete(user.organizationId, dto.ids, user.id);
  }

  @Patch('bulk-province')
  @HttpCode(200)
  bulkUpdateProvince(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkUpdateProvinceDto,
  ) {
    this.assertCanSetProvince(user);

    return this.activityDataService.bulkUpdateProvince(
      user.organizationId,
      dto.ids,
      dto.province,
      user.id,
    );
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ActivityDataQueryDto,
  ) {
    return this.activityDataService.findAll(user.organizationId, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.activityDataService.findOne(user.organizationId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateActivityDataDto,
  ) {
    return this.activityDataService.update(user.organizationId, id, dto, user.id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.activityDataService.remove(user.organizationId, id, user.id);
  }

  private assertCanSetProvince(user: AuthenticatedUser) {
    if (user.accountType === 'PILOT_REVIEWER') {
      throw new ForbiddenException('Pilot reviewer accounts are read-only for sample data.');
    }

    if (!user.organizationId) {
      throw new ForbiddenException('Your account is not connected to a workspace.');
    }

    const role = String(user.role ?? '').trim().toUpperCase();
    const membershipRole = String(user.membershipRole ?? '').trim().toUpperCase();
    if (role === 'VIEWER' || role === 'REVIEWER' || membershipRole === 'VIEWER') {
      throw new ForbiddenException('Your current role does not allow setting province.');
    }
  }
}
