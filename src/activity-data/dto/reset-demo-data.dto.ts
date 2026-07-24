import { Equals, IsString } from 'class-validator';

export const RESET_DEMO_DATA_CONFIRMATION = 'RESET DEMO DATA';

export class ResetDemoDataDto {
  @IsString()
  @Equals(RESET_DEMO_DATA_CONFIRMATION)
  confirmation!: string;
}
