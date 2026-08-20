import { validate } from 'class-validator';
import { CreatePilotReviewerDto } from './create-pilot-reviewer.dto';

const EMAIL_VALIDATION_MESSAGE =
  'Please enter a valid email address, for example name@example.com.';

function buildDto(email: string) {
  const dto = new CreatePilotReviewerDto();
  dto.name = 'Test Reviewer';
  dto.email = email;
  return dto;
}

describe('CreatePilotReviewerDto', () => {
  it('accepts plain emails with surrounding whitespace for service normalization', async () => {
    const errors = await validate(buildDto('  Reviewer@Example.com  '));

    expect(errors).toHaveLength(0);
  });

  it.each([
    '[alexander@example.com](mailto:alexander@example.com)',
    'mailto:alexander@example.com',
    'alexander example.com',
    '"alexander@example.com"',
    '(alexander@example.com)',
    '[alexander@example.com]',
  ])('rejects unsafe email value %s', async (email) => {
    const errors = await validate(buildDto(email));

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      EMAIL_VALIDATION_MESSAGE,
    );
  });
});
