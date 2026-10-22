import { sanitizeSentryEvent } from './sentry-event';
import type { ErrorEvent } from '@sentry/nestjs';
it('blocks SDK/provider error payloads, requests, headers, cookies, URLs and breadcrumbs at final transport', () => {
  const event: ErrorEvent = {
    type: undefined,
    event_id: 'event-1', level: 'error',
    message: 'secret-message', transaction: '/source/secret-param?token=secret-query',
    request: { url: '/secret-url', headers: { Authorization: 'secret-auth' }, cookies: { session: 'secret-session' }, data: 'secret-body' },
    exception: { values: [{ value: 'secret-provider', stacktrace: { frames: [{ vars: { password: 'secret-stack' } }] } }] },
    extra: { config: { apiKey: 'secret-key' }, input: 'secret-base64' },
    breadcrumbs: [{ message: 'secret-breadcrumb' }],
    tags: { feature: 'document-extraction', operation: 'extract' },
    contexts: { carbonlite: { organizationId: 'org-1', entityId: 'doc-1', error: { status: 502 }, metadata: { access_token: 'secret-token', rawOcrText: 'secret-content' } } },
  };
  const before = JSON.stringify(event);
  const serialized = JSON.stringify(sanitizeSentryEvent(event));
  expect(serialized).not.toContain('secret-');
  expect(serialized).toContain('doc-1'); expect(serialized).toContain('502'); expect(serialized).toContain('[REDACTED]');
  expect(JSON.stringify(event)).toBe(before);
});
it('drops uninspectable events rather than failing exception handling', () => {
  expect(sanitizeSentryEvent(new Proxy({}, { get() { throw Error('secret'); } }) as ErrorEvent)).toBeNull();
});
