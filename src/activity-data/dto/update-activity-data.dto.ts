import { PartialType } from '@nestjs/mapped-types';
import { CreateActivityDataDto } from './create-activity-data.dto';

export class UpdateActivityDataDto extends PartialType(CreateActivityDataDto) {}