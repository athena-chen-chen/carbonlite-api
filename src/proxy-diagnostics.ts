import express, { Express, Request } from 'express';
import { Server } from 'node:http';

type DiagnosticLogger = (message: string) => void;

export function createProxyDiagnosticsApp(
  environment: NodeJS.ProcessEnv = process.env,
  log: DiagnosticLogger = console.log,
): Express {
  const app = express();
  const trustProxyHops = resolveTrustProxyHops(environment);

  app.disable('x-powered-by');
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  app.get('/api/health/live', (request, response) => {
    logProxyDiagnostics(request, environment, trustProxyHops, log);
    response.status(200).json({ status: 'ok' });
  });

  return app;
}

export function startProxyDiagnosticsServer(
  environment: NodeJS.ProcessEnv = process.env,
  log: DiagnosticLogger = console.log,
): Server {
  const port = resolvePort(environment.PORT);
  return createProxyDiagnosticsApp(environment, log).listen(port);
}

export function resolveTrustProxyHops(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = String(environment.TRUST_PROXY_HOPS ?? '0').trim();
  const parsed = Number(configured);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
  }

  return parsed;
}

function logProxyDiagnostics(
  request: Request,
  environment: NodeJS.ProcessEnv,
  trustProxyHops: number,
  log: DiagnosticLogger,
) {
  if (environment.PROXY_DIAGNOSTICS_ENABLED !== 'true') {
    return;
  }

  log(
    JSON.stringify({
      event: 'proxy_diagnostics',
      socketRemoteAddress: request.socket.remoteAddress,
      xForwardedFor: request.headers['x-forwarded-for'],
      cfConnectingIp: request.headers['cf-connecting-ip'],
      cfRay: request.headers['cf-ray'],
      resolvedClientIp: request.ip,
      trustProxyHops,
    }),
  );
}

function resolvePort(configured: string | undefined): number {
  const parsed = Number(configured ?? '3333');
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }
  return parsed;
}
