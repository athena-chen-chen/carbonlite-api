import { validate } from 'class-validator';
import {
  CreatePilotReviewerDto,
  InvitationPurpose,
} from './create-pilot-reviewer.dto';

const EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example name@example.com.';

function buildDto(email: string, invitationPurpose?: InvitationPurpose) {
  const dto = new CreatePilotReviewerDto();
  dto.name = 'Test Reviewer';
  dto.email = email;
  if (invitationPurpose) dto.invitationPurpose = invitationPurpose;
  return dto;
}

describe('CreatePilotReviewerDto', () => {
  it('accepts plain emails with surrounding whitespace for service normalization', async () => {
    const errors = await validate(buildDto('  Reviewer@Example.com  ', InvitationPurpose.CUSTOMER));

    expect(errors).toHaveLength(0);
  });

  it.each(Object.values(InvitationPurpose))('accepts invitation purpose %s', async (purpose) => {
    const dto = buildDto('reviewer@example.com', purpose);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an omitted invitation purpose instead of silently creating a demo', async () => {
    const errors = await validate(buildDto('reviewer@example.com'));

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('invitationPurpose');
    expect(errors[0].constraints).toMatchObject({
      isEnum: 'invitationPurpose must be one of the following values: DEMO, CUSTOMER',
    });
  });

  it('rejects an invalid invitation purpose', async () => {
    const dto = buildDto('reviewer@example.com');
    dto.invitationPurpose = 'TRIAL' as InvitationPurpose;
    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('invitationPurpose');
  });

  it.each([
    '[alexander@example.com](mailto:alexander@example.com)',
    'mailto:alexander@example.com',
    'alexander example.com',
    '"alexander@example.com"',
    '(alexander@example.com)',
    '[alexander@example.com]',
    'alexander@gamil.com',
  ])('rejects unsafe email value %s', async (email) => {
    const errors = await validate(buildDto(email, InvitationPurpose.CUSTOMER));

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      EMAIL_VALIDATION_MESSAGE,
    );
  });
});
