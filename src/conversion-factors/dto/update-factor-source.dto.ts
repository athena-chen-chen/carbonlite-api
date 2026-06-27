import { PartialType } from '@nestjs/mapped-types';
import { CreateFactorSourceDto } from './create-factor-source.dto';

export class UpdateFactorSourceDto extends PartialType(CreateFactorSourceDto) {}
