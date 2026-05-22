import {
  Body,
  Controller,
  Delete,
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
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('activity-data')
export class ActivityDataController {
  constructor(
    @Inject(ActivityDataService)
    private readonly activityDataService: ActivityDataService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateActivityDataDto) {
    return this.activityDataService.create(user.organizationId, dto);
  }

  @Post('bulk-import')
  bulkImport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkImportActivityDataDto,
  ) {
    return this.activityDataService.bulkImport(user.organizationId, dto);
  }

  @Post('bulk-delete')
  @HttpCode(200)
  bulkDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkDeleteActivityDataDto,
  ) {
    return this.activityDataService.bulkDelete(user.organizationId, dto.ids);
  }

  @Delete('bulk-delete')
  @HttpCode(200)
  bulkDeleteWithDelete(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkDeleteActivityDataDto,
  ) {
    return this.activityDataService.bulkDelete(user.organizationId, dto.ids);
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
    return this.activityDataService.update(user.organizationId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.activityDataService.remove(user.organizationId, id);
  }
  
}
