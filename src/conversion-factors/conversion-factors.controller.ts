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
  UseGuards,
} from '@nestjs/common';
import { ConversionFactorsService } from './conversion-factors.service';
import { CreateConversionFactorDto } from './dto/create-conversion-factor.dto';
import { UpdateConversionFactorDto } from './dto/update-conversion-factor.dto';
import { ConversionFactorQueryDto } from './dto/conversion-factor-query.dto';
import { AuthenticatedUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { throwCapturedAppError } from '../common/monitoring/capture-app-error';

@UseGuards(JwtAuthGuard)
@Controller('conversion-factors')
export class ConversionFactorsController {
  constructor(
    @Inject(ConversionFactorsService)
    private readonly conversionFactorsService: ConversionFactorsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConversionFactorDto,
  ) {
    try {
      return await this.conversionFactorsService.create(
        user.organizationId,
        dto,
        user.id,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'conversion-factors',
          operation: 'create',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'ConversionFactor',
          metadata: {
            route: '/api/conversion-factors',
            method: 'POST',
            activityType: dto.activityType,
            factorType: dto.type,
            unit: dto.unit,
          },
        },
        'Conversion factor could not be created. Please try again.',
      );
    }
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ConversionFactorQueryDto,
  ) {
    return this.conversionFactorsService.findAll(user.organizationId, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.conversionFactorsService.findOne(user.organizationId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateConversionFactorDto,
  ) {
    try {
      return await this.conversionFactorsService.update(
        user.organizationId,
        id,
        dto,
        user.id,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'conversion-factors',
          operation: 'update',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'ConversionFactor',
          entityId: id,
          metadata: {
            route: '/api/conversion-factors/:id',
            method: 'PATCH',
            changedFields: Object.keys(dto),
          },
        },
        'Conversion factor could not be updated. Please try again.',
      );
    }
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    try {
      return await this.conversionFactorsService.remove(
        user.organizationId,
        id,
        user.id,
      );
    } catch (error) {
      throwCapturedAppError(
        error,
        {
          feature: 'conversion-factors',
          operation: 'delete',
          userId: user.id,
          userEmail: user.email,
          organizationId: user.organizationId,
          entityType: 'ConversionFactor',
          entityId: id,
          metadata: {
            route: '/api/conversion-factors/:id',
            method: 'DELETE',
          },
        },
        'Conversion factor could not be deleted. Please try again.',
      );
    }
  }
}
