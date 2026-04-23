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
import { ConversionFactorsService } from './conversion-factors.service';
import { CreateConversionFactorDto } from './dto/create-conversion-factor.dto';
import { UpdateConversionFactorDto } from './dto/update-conversion-factor.dto';
import { ConversionFactorQueryDto } from './dto/conversion-factor-query.dto';

@Controller('conversion-factors')
export class ConversionFactorsController {
  constructor(
    @Inject(ConversionFactorsService)
    private readonly conversionFactorsService: ConversionFactorsService,
  ) {}

  @Post()
  create(@Body() dto: CreateConversionFactorDto) {
    return this.conversionFactorsService.create(dto);
  }

  @Get()
  findAll(@Query() query: ConversionFactorQueryDto) {
    return this.conversionFactorsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.conversionFactorsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateConversionFactorDto) {
    return this.conversionFactorsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.conversionFactorsService.remove(id);
  }
}