// src/factors/factors.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import { FactorsService } from './factors.service';
import { CreateFactorDto } from './dto/create-factor.dto';
import { UpdateFactorDto } from './dto/update-conversion-factor.dto';

@Controller('factors')
export class FactorsController {
  constructor(private readonly factorsService: FactorsService) {}

  // @Get()
  // findAll() {
  //   return this.factorsService.findAll();
  // }

  // @Post()
  // create(@Body() dto: CreateFactorDto, @Req() req: any) {
  //   // TODO: enforce role === ADMIN or REPORTING
  //   const userId = req.user?.id ?? null; // after auth middleware
  //   return this.factorsService.create(dto, userId);
  // }

  // @Patch(':id')
  // update(
  //   @Param('id') id: string,
  //   @Body() dto: UpdateFactorDto,
  //   @Req() req: any,
  // ) {
  //   const userId = req.user?.id ?? null;
  //   return this.factorsService.update(id, dto, userId);
  // }

  // @Delete(':id')
  // remove(@Param('id') id: string) {
  //   // TODO: restrict to ADMIN
  //   return this.factorsService.remove(id);
  // }
}
