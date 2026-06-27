import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { CreateFactorSourceDto } from './dto/create-factor-source.dto';
import { UpdateFactorSourceDto } from './dto/update-factor-source.dto';
import { FactorSourcesService } from './factor-sources.service';

@UseGuards(JwtAuthGuard)
@Controller('factor-sources')
export class FactorSourcesController {
  constructor(private readonly factorSourcesService: FactorSourcesService) {}

  @Get()
  findAll(@Query() query: { includeArchived?: string }) {
    return this.factorSourcesService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.factorSourcesService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFactorSourceDto) {
    return this.factorSourcesService.create(dto, {
      userId: user.id,
      organizationId: user.organizationId,
    });
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateFactorSourceDto,
  ) {
    return this.factorSourcesService.update(id, dto, {
      userId: user.id,
      organizationId: user.organizationId,
    });
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @UseGuards(RolesGuard)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.factorSourcesService.remove(id, {
      userId: user.id,
      organizationId: user.organizationId,
    });
  }
}
