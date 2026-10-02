import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { assertCanContributeActivityData } from '../common/permissions/activity-data-permissions';
import { SaveSpreadsheetReviewRowsDto } from './dto/save-spreadsheet-review-rows.dto';
import { SpreadsheetReviewRowQueryDto } from './dto/spreadsheet-review-row-query.dto';
import { SpreadsheetImportService } from './spreadsheet-import.service';

@UseGuards(JwtAuthGuard)
@Controller('spreadsheet-import')
export class SpreadsheetImportController {
  constructor(
    @Inject(SpreadsheetImportService)
    private readonly spreadsheetImportService: SpreadsheetImportService,
  ) {}

  @Get('review-rows')
  findReviewRows(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SpreadsheetReviewRowQueryDto,
  ) {
    return this.spreadsheetImportService.findReviewRows(
      user.organizationId,
      query,
    );
  }

  @Post('review-rows')
  saveReviewRows(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveSpreadsheetReviewRowsDto,
  ) {
    assertCanContributeActivityData(user);

    return this.spreadsheetImportService.saveReviewRows(
      user.organizationId,
      dto,
      user.id,
    );
  }
}
