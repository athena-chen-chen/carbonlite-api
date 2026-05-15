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

@UseGuards(JwtAuthGuard)
@Controller('conversion-factors')
export class ConversionFactorsController {
  constructor(
    @Inject(ConversionFactorsService)
    private readonly conversionFactorsService: ConversionFactorsService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateConversionFactorDto,
  ) {
    return this.conversionFactorsService.create(user.organizationId, dto);
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
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateConversionFactorDto,
  ) {
    return this.conversionFactorsService.update(user.organizationId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.conversionFactorsService.remove(user.organizationId, id);
  }
}
