import { Logger } from '@nestjs/common';
import { trackOptionalActivity } from './activity-tracking.service';

afterEach(() => jest.restoreAllMocks());
it('awaits optional events and logs bounded identifiers without payloads or exception contents', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const track = jest.fn().mockRejectedValue(new Error('secret-provider-error'));
  await expect(trackOptionalActivity({ track }, {
    organizationId: 'org', entityId: 'doc', entityType: 'Document', eventName: 'DOCUMENT_UPLOADED',
    metadata: { extractedText: 'private-source-payload' },
  })).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  const message = warn.mock.calls[0][0];
  expect(message).toContain('DOCUMENT_UPLOADED');
  expect(message).toContain('doc');
  expect(message).not.toContain('private-source-payload');
  expect(message).not.toContain('secret-provider-error');
});
it('cannot mask success even when both the optional writer and its logger fail', async () => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => { throw Error('logger'); });
  await expect(trackOptionalActivity({ track: jest.fn().mockRejectedValue(Error('event')) }, { eventName: 'EVENT' })).resolves.toBeUndefined();
});
