import { Body, Controller, Headers, Post } from '@nestjs/common';
import { CreatePilotReviewerDto } from './dto/create-pilot-reviewer.dto';
import { DeactivatePilotReviewerDto } from './dto/deactivate-pilot-reviewer.dto';
import { RegeneratePilotReviewerInviteDto } from './dto/regenerate-pilot-reviewer-invite.dto';
import { AuthService } from './auth.service';

@Controller('admin/pilot-reviewers')
export class AdminPilotReviewersController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  async createPilotReviewer(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreatePilotReviewerDto,
  ) {
    const user = await this.auth.authenticatePilotReviewerCreator(authorization);
    return this.auth.createPilotReviewer(user, dto);
  }

  @Post('deactivate')
  async deactivatePilotReviewer(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: DeactivatePilotReviewerDto,
  ) {
    const user = await this.auth.authenticatePilotReviewerCreator(authorization);
    return this.auth.deactivatePilotReviewer(user, dto);
  }

  @Post('regenerate-invite')
  async regeneratePilotReviewerInvite(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: RegeneratePilotReviewerInviteDto,
  ) {
    const user = await this.auth.authenticatePilotReviewerCreator(authorization);
    return this.auth.regeneratePilotReviewerInvite(user, dto);
  }
}
