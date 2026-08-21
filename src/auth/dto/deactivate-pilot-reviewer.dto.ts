import { Matches } from 'class-validator';

export const PILOT_REVIEWER_EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example name@example.com.';

export class DeactivatePilotReviewerDto {
  @Matches(/^\s*(?!.*mailto:)[^\s@()[\]"']+@[^\s@()[\]"']+\.[^\s@()[\]"']+\s*$/i, {
    message: PILOT_REVIEWER_EMAIL_VALIDATION_MESSAGE,
  })
  email!: string;
}
