import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';

export enum MetricTypeDto {
  CARBON_EMISSION = 'CARBON_EMISSION',
  ENERGY_CONSUMPTION = 'ENERGY_CONSUMPTION',
  ENERGY_INTENSITY = 'ENERGY_INTENSITY',
  COST_ESTIMATE = 'COST_ESTIMATE',
  CUSTOM = 'CUSTOM',
}

export class CalculateMetricsDto {
  @IsOptional()
  @IsString()
  facilityId?: string;

  @IsOptional()
  @IsArray()
  activityDataIds?: string[];

  @IsArray()
  @IsEnum(MetricTypeDto, { each: true })
  metricTypes!: MetricTypeDto[];

  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;
}