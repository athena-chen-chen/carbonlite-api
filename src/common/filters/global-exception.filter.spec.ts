import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

jest.mock('../monitoring/capture-app-error', () => ({ captureAppError: jest.fn(), wasAppErrorCaptured: jest.fn(() => false) }));
import { captureAppError } from '../monitoring/capture-app-error';

afterEach(() => jest.restoreAllMocks());
it('omits payloads, concrete route/query credentials and exception contents from final logger arguments', () => {
  const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const json = jest.fn(); const status = jest.fn(() => ({ json }));
  const body: any = { account: { refreshToken: 'secret-token' }, items: [{ password: 'secret-password' }], extractedSourceText: 'secret-source'.repeat(10000) }; body.cycle = body;
  const request = { method: 'POST', route: { path: '/api/source/:documentId' }, originalUrl: '/api/source/secret-path?accessToken=secret-query', body, headers: { authorization: 'Bearer secret-jwt', cookie: 'secret-cookie' }, user: { id: 'user-1', organizationId: 'org-1' } };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }) } as ArgumentsHost;
  new GlobalExceptionFilter().catch(new Error('secret-provider'), host);
  const output = JSON.stringify([logger.mock.calls, jest.mocked(captureAppError).mock.calls.map(call => call[1])]);
  expect(output).not.toContain('secret-');
  expect(output).toContain('org-1'); expect(output).toContain('/api/source/:documentId');
  expect(status).toHaveBeenCalledWith(500);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Internal server error', path: request.originalUrl }));
  expect(body.account.refreshToken).toBe('secret-token');
});
it('preserves the original response when the logger throws and body is hostile', () => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => { throw Error('logger failed'); });
  const json = jest.fn(); const status = jest.fn(() => ({ json }));
  const request = { method: 'POST', url: '/api/test', body: new Proxy({}, { ownKeys() { throw Error('body'); } }) };
  const host = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }) } as ArgumentsHost;
  expect(() => new GlobalExceptionFilter().catch(new HttpException('Existing public message', 503), host)).not.toThrow();
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503, message: 'Existing public message' }));
});
