import { PartialType } from '@nestjs/mapped-types';
import { CreateEmissionDto } from './create-emission.dto';
export class UpdateEmissionDto extends PartialType(CreateEmissionDto) {}
