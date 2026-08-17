import { Body, Controller, Headers, Post } from '@nestjs/common';
import { CreatePilotReviewerDto } from './dto/create-pilot-reviewer.dto';
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
}
