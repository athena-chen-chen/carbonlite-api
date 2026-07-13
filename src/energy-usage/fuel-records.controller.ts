// src/fuel-records/fuel-records.controller.ts
import { Controller } from '@nestjs/common';
import { FuelRecordsService } from './fuel-records.service';

@Controller('fuel-records')
export class FuelRecordsController {
  constructor(private readonly fuelRecordsService: FuelRecordsService) {}

  // @Get()
  // findRecent() {
  //   return this.fuelRecordsService.findRecent();
  // }

  // @Post()
  // create(@Body() dto: CreateFuelRecordDto, @Req() req: any) {
  //   // data-entry users are allowed here
  //   const userId = req.user?.id ?? null;
  //   return this.fuelRecordsService.create(dto, userId);
  // }
}
