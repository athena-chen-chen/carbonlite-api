import express from 'express';
import request from 'supertest';
import {
  configureHttpSecurity,
  resolveCorsAllowedOrigins,
  resolveRateLimitPolicies,
  resolveTrustProxyHops,
} from './http-security';

describe('HTTP security configuration', () => {
  it('requires an explicit production CORS allowlist', () => {
    expect(() =>
      resolveCorsAllowedOrigins({ APP_ENV: 'production' }),
    ).toThrow('CORS_ALLOWED_ORIGINS is required in production');

    expect(
      resolveCorsAllowedOrigins({
        APP_ENV: 'production',
        CORS_ALLOWED_ORIGINS:
          'https://app.carbonlite.example, https://admin.carbonlite.example ',
      }),
    ).toEqual([
      'https://app.carbonlite.example',
      'https://admin.carbonlite.example',
    ]);
    for (const invalid of ['*', 'not-an-origin', 'ftp://app.example', 'https://app.example/path']) {
      expect(() => resolveCorsAllowedOrigins({
        APP_ENV: 'production',
        CORS_ALLOWED_ORIGINS: invalid,
      })).toThrow('must contain only explicit HTTP(S) origins');
    }
  });

  it('defaults local development CORS to the frontend development origin', () => {
    expect(resolveCorsAllowedOrigins({ NODE_ENV: 'development' })).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('requires an explicit production reverse-proxy hop count', () => {
    expect(() => resolveTrustProxyHops({ APP_ENV: 'production' })).toThrow(
      'TRUST_PROXY_HOPS is required in production',
    );
    expect(
      resolveTrustProxyHops({
        APP_ENV: 'production',
        TRUST_PROXY_HOPS: '1',
      }),
    ).toBe(1);
    expect(() =>
      resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' }),
    ).toThrow('TRUST_PROXY_HOPS must be a non-negative integer');
  });

  it('rate limits every required sensitive endpoint conservatively', () => {
    expect(resolveRateLimitPolicies({})).toEqual([
      { path: '/api/auth/login', windowMs: 900_000, limit: 10 },
      { path: '/api/auth/register', windowMs: 3_600_000, limit: 3 },
      { path: '/api/auth/set-password', windowMs: 900_000, limit: 5 },
      {
        path: '/api/auth/password-reset/confirm',
        windowMs: 900_000,
        limit: 5,
      },
      { path: '/api/documents/upload', windowMs: 3_600_000, limit: 20 },
      {
        path: '/api/document-extraction/extract',
        windowMs: 3_600_000,
        limit: 10,
      },
    ]);
  });

  it('accepts positive per-endpoint overrides and rejects unsafe values', () => {
    const policies = resolveRateLimitPolicies({
      LOGIN_RATE_LIMIT: '7',
      REGISTRATION_RATE_LIMIT: '0',
    });

    expect(policies[0].limit).toBe(7);
    expect(policies[1].limit).toBe(3);
  });

  it('returns HTTP 429 for every sensitive endpoint and enables Helmet', async () => {
    const server = express();
    const app = {
      use: server.use.bind(server),
      set: server.set.bind(server),
      enableCors: jest.fn(),
    };
    configureHttpSecurity(app as never, {
      NODE_ENV: 'test',
      LOGIN_RATE_LIMIT: '1',
      REGISTRATION_RATE_LIMIT: '1',
      PASSWORD_SETUP_RATE_LIMIT: '1',
      DOCUMENT_UPLOAD_RATE_LIMIT: '1',
      AI_EXTRACTION_RATE_LIMIT: '1',
    });

    for (const { path } of resolveRateLimitPolicies({})) {
      const first = await request(server).post(path).expect(404);
      expect(first.headers['x-content-type-options']).toBe('nosniff');
      await request(server).post(path).expect(429).expect(({ body }) => {
        expect(body).toEqual(expect.objectContaining({ statusCode: 429 }));
      });
    }
    expect(app.enableCors).toHaveBeenCalledWith({
      origin: ['http://localhost:5173'],
      credentials: true,
    });
  });
});
