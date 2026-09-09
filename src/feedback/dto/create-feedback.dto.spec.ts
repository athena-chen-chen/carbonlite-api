import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateFeedbackDto } from './create-feedback.dto';

describe('CreateFeedbackDto', () => {
  function buildDto(overrides: Partial<CreateFeedbackDto> = {}) {
    return plainToInstance(CreateFeedbackDto, {
      type: 'BUG',
      intent: 'Report feedback issue',
      message: 'The feedback form failed.',
      ...overrides,
    });
  }

  it('accepts backend-safe pilot reviewer feedback fields', async () => {
    const errors = await validate(
      buildDto({
        type: 'BUG',
        email: 'reviewer@example.com',
        page: '/reports',
        url: 'https://www.carbonliteapp.ca/reports',
      }),
    );

    expect(errors).toHaveLength(0);
  });

  it('normalizes blank optional email so feedback can be submitted without contact email', async () => {
    const dto = buildDto({ email: '   ' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.email).toBeUndefined();
  });

  it('trims and lowercases optional email before validation', async () => {
    const dto = buildDto({ email: ' Reviewer@Example.com ' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('reviewer@example.com');
  });

  it('rejects invalid feedback type labels instead of accepting UI labels', async () => {
    const errors = await validate(buildDto({ type: 'Bug' as CreateFeedbackDto['type'] }));

    expect(errors.some((error) => error.property === 'type')).toBe(true);
  });

  it('rejects markdown email links', async () => {
    const errors = await validate(
      buildDto({ email: '[reviewer@example.com](mailto:reviewer@example.com)' }),
    );

    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });
});
