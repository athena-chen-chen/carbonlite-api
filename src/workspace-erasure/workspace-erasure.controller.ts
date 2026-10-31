import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { EraseWorkspaceDto, WorkspaceErasureDryRunDto } from './dto/workspace-erasure.dto';
import { WorkspaceErasureService } from './workspace-erasure.service';

@Controller('admin/workspace-erasure')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class WorkspaceErasureController {
  constructor(private readonly erasure: WorkspaceErasureService) {}

  @Post('dry-run')
  dryRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WorkspaceErasureDryRunDto,
  ) {
    return this.erasure.dryRun(user, dto.organizationId);
  }

  @Post('erase')
  erase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EraseWorkspaceDto,
  ) {
    return this.erasure.erase(user, dto);
  }
}
