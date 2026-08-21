import { Matches } from 'class-validator';
import {
  PILOT_REVIEWER_EMAIL_VALIDATION_MESSAGE,
} from './deactivate-pilot-reviewer.dto';

export class RegeneratePilotReviewerInviteDto {
  @Matches(/^\s*(?!.*mailto:)[^\s@()[\]"']+@[^\s@()[\]"']+\.[^\s@()[\]"']+\s*$/i, {
    message: PILOT_REVIEWER_EMAIL_VALIDATION_MESSAGE,
  })
  email!: string;
}
