import { validate } from 'class-validator';
import { SuspendCustomerOrganizationDto } from './suspend-customer-organization.dto';

function command(reason?: string) {
  return Object.assign(new SuspendCustomerOrganizationDto(), {
    organizationId: 'org-a',
    confirmationOrganizationId: 'org-a',
    confirmationOrganizationSlug: 'org-a',
    confirmSuspend: true,
    ...(reason === undefined ? {} : { suspensionReason: reason }),
  });
}

describe('SuspendCustomerOrganizationDto', () => {
  it.each([
    ['missing', undefined],
    ['blank', '   \t'],
    ['over-length', 'x'.repeat(501)],
  ])('rejects a %s suspension reason', async (_case, reason) => {
    const errors = await validate(command(reason));

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'suspensionReason' }),
      ]),
    );
  });

  it('accepts a non-empty reason at the maximum length', async () => {
    await expect(validate(command('x'.repeat(500)))).resolves.toHaveLength(0);
  });
});
