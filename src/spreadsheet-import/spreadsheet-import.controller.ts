import { WorkspaceMutationGuard } from '../auth/guards/workspace-mutation.guard';
import { Body, Controller, Get, Headers, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { assertCanContributeActivityData } from '../common/permissions/activity-data-permissions';
import { SaveSpreadsheetReviewRowsDto } from './dto/save-spreadsheet-review-rows.dto';
import { SpreadsheetReviewRowQueryDto } from './dto/spreadsheet-review-row-query.dto';
import { SpreadsheetImportService } from './spreadsheet-import.service';
import { RealDataAuthorizationService } from '../real-data-authorization/real-data-authorization.service';

@UseGuards(JwtAuthGuard, WorkspaceMutationGuard)
@Controller('spreadsheet-import')
export class SpreadsheetImportController {
  constructor(
    @Inject(SpreadsheetImportService)
    private readonly spreadsheetImportService: SpreadsheetImportService,
    private readonly realDataAuthorization: RealDataAuthorizationService,
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
  async saveReviewRows(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaveSpreadsheetReviewRowsDto,
    @Headers('x-carbonlite-data-mode') rawDataMode?: string,
  ) {
    assertCanContributeActivityData(user);

    const ingestionDataMode = await this.realDataAuthorization.resolveIngestionMode(
      user.organizationId,
      rawDataMode,
      user.id,
    );

    return this.spreadsheetImportService.saveReviewRows(
      user.organizationId,
      dto,
      user.id,
      ingestionDataMode,
    );
  }
}
