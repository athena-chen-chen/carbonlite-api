import { PartialType } from '@nestjs/mapped-types';
import { CreateFactorVersionDto } from './create-factor-version.dto';

export class UpdateFactorVersionDraftDto extends PartialType(CreateFactorVersionDto) {}
