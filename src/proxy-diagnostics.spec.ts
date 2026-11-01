import request from 'supertest';
import {
  createProxyDiagnosticsApp,
  resolveTrustProxyHops,
  startProxyDiagnosticsServer,
} from './proxy-diagnostics';

describe('temporary proxy diagnostics server', () => {
  it('starts without DATABASE_URL and serves only liveness', async () => {
    const environment = {
      PROXY_DIAGNOSTICS_ENABLED: 'false',
      TRUST_PROXY_HOPS: '0',
      PORT: '0',
    };
    const log = jest.fn();
    const server = startProxyDiagnosticsServer(environment, log);

    try {
      await request(server)
        .get('/api/health/live')
        .expect(200, { status: 'ok' });
      await request(server).get('/api/health').expect(404);
      await request(server).get('/api/health/ready').expect(404);
      expect(log).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('logs only allowlisted raw proxy headers and ignores spoofing at zero hops', async () => {
    const log = jest.fn();
    const app = createProxyDiagnosticsApp(
      { PROXY_DIAGNOSTICS_ENABLED: 'true', TRUST_PROXY_HOPS: '0' },
      log,
    );

    await request(app)
      .get('/api/health/live')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('CF-Connecting-IP', '198.51.100.20')
      .set('CF-Ray', 'example-YYC')
      .set('Authorization', 'Bearer private')
      .expect(200);

    expect(log).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(String(log.mock.calls[0][0]));
    expect(diagnostic).toMatchObject({
      event: 'proxy_diagnostics',
      xForwardedFor: '1.2.3.4',
      cfConnectingIp: '198.51.100.20',
      cfRay: 'example-YYC',
      trustProxyHops: 0,
    });
    expect(diagnostic.socketRemoteAddress).toEqual(expect.any(String));
    expect(diagnostic.resolvedClientIp).toBe(diagnostic.socketRemoteAddress);
    expect(log.mock.calls[0][0]).not.toContain('private');
  });

  it('resolves the forwarded client with one trusted proxy hop', async () => {
    const log = jest.fn();
    const app = createProxyDiagnosticsApp(
      { PROXY_DIAGNOSTICS_ENABLED: 'true', TRUST_PROXY_HOPS: '1' },
      log,
    );

    await request(app)
      .get('/api/health/live')
      .set('X-Forwarded-For', '1.2.3.4')
      .expect(200);

    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      xForwardedFor: '1.2.3.4',
      resolvedClientIp: '1.2.3.4',
      trustProxyHops: 1,
    });
  });

  it('rejects an invalid trust proxy configuration', () => {
    expect(() => resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' })).toThrow(
      'TRUST_PROXY_HOPS must be a non-negative integer.',
    );
  });
});
