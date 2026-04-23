import { IsString, IsNumber, IsOptional, IsPositive } from 'class-validator';

export class CreateFuelRecordDto {
  @IsString()
  facilityId!: string;

  @IsString()
  fuelType!: string; // Diesel | Natural Gas | Gasoline | ...

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  unit!: string; // L | m³ | gal | ...

  @IsString()
  date!: string; // YYYY-MM-DD

  @IsOptional()
  @IsString()
  note?: string;
}
