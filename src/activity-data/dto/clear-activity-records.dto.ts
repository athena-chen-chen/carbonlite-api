import { Equals, IsString } from 'class-validator';

export const CLEAR_ACTIVITY_RECORDS_CONFIRMATION = 'CLEAR RECORDS';

export class ClearActivityRecordsDto {
  @IsString()
  @Equals(CLEAR_ACTIVITY_RECORDS_CONFIRMATION)
  confirmation!: string;
}
