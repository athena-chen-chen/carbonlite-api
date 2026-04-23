import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ActivityDataService } from './activity-data.service';
import { CreateActivityDataDto } from './dto/create-activity-data.dto';
import { UpdateActivityDataDto } from './dto/update-activity-data.dto';
import { ActivityDataQueryDto } from './dto/activity-data-query.dto';
import { BulkImportActivityDataDto } from './dto/bulk-import-activity-data.dto';

@Controller('activity-data')
export class ActivityDataController {
  constructor(
    @Inject(ActivityDataService)
    private readonly activityDataService: ActivityDataService,
  ) {}

  @Post()
  create(@Body() dto: CreateActivityDataDto) {
    return this.activityDataService.create(dto);
  }

  @Post('bulk-import')
  bulkImport(@Body() dto: BulkImportActivityDataDto) {
    return this.activityDataService.bulkImport(dto);
  }

  @Get()
  findAll(@Query() query: ActivityDataQueryDto) {
    return this.activityDataService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.activityDataService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateActivityDataDto) {
    return this.activityDataService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.activityDataService.remove(id);
  }
}