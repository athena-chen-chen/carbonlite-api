import { AuditLogService } from '../src/audit-log/audit-log.service';
import {
  assertPlatformAdminBootstrapOperatorGuards,
  PlatformAdminBootstrapError,
  PlatformAdminBootstrapService,
} from '../src/auth/platform-admin-bootstrap.service';
import { PrismaService } from '../src/prisma/prisma.service';

type CliArguments = {
  email: string;
  name: string;
  anchorOrganizationId: string;
  confirmEnvironment: string;
  setupBaseUrl: string;
};

function readArguments(argv: string[]): CliArguments {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const allowed = new Set([
    'email',
    'name',
    'anchor-organization-id',
    'confirm-environment',
    'setup-base-url',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    const normalizedKey = key?.startsWith('--') ? key.slice(2) : '';
    if (
      !normalizedKey ||
      !allowed.has(normalizedKey) ||
      values.has(normalizedKey) ||
      !value
    ) {
      throw new PlatformAdminBootstrapError(
        'PLATFORM_ADMIN_BOOTSTRAP_ARGUMENTS_INVALID',
      );
    }
    values.set(normalizedKey, value);
  }

  const result = {
    email: values.get('email') ?? '',
    name: values.get('name') ?? '',
    anchorOrganizationId: values.get('anchor-organization-id') ?? '',
    confirmEnvironment: values.get('confirm-environment') ?? '',
    setupBaseUrl: values.get('setup-base-url') ?? '',
  };
  if (Object.values(result).some((value) => !value.trim())) {
    throw new PlatformAdminBootstrapError(
      'PLATFORM_ADMIN_BOOTSTRAP_ARGUMENTS_INVALID',
    );
  }
  return result;
}

function buildSetupUrl(baseUrl: string, token: string) {
  let url: URL;
  try {
    url = new URL('/set-password', baseUrl);
  } catch {
    throw new PlatformAdminBootstrapError(
      'PLATFORM_ADMIN_BOOTSTRAP_SETUP_URL_INVALID',
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new PlatformAdminBootstrapError(
      'PLATFORM_ADMIN_BOOTSTRAP_SETUP_URL_INVALID',
    );
  }
  url.searchParams.set('token', token);
  return url.toString();
}

async function main() {
  const input = readArguments(process.argv.slice(2));
  assertPlatformAdminBootstrapOperatorGuards(input, process.env);
  // Validate the non-secret destination before opening a database connection.
  buildSetupUrl(input.setupBaseUrl, 'validation-only');

  const prisma = new PrismaService();
  const auditLog = new AuditLogService(prisma);
  const bootstrap = new PlatformAdminBootstrapService(prisma, auditLog);

  try {
    await prisma.$connect();
    const result = await bootstrap.bootstrap({
      email: input.email,
      name: input.name,
      anchorOrganizationId: input.anchorOrganizationId,
      confirmEnvironment: input.confirmEnvironment,
    });
    const setupUrl = buildSetupUrl(input.setupBaseUrl, result.setupToken);

    process.stdout.write(
      `PLATFORM_ADMIN_BOOTSTRAPPED userId=${result.userId} ` +
        `environment=${input.confirmEnvironment} ` +
        `setupExpiresAt=${result.setupExpiresAt.toISOString()}\n`,
    );
    // This is the only plaintext credential emission. It is intended for the
    // interactive operator and must never be redirected to routine logs.
    process.stdout.write(`ONE_TIME_SETUP_URL=${setupUrl}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof PlatformAdminBootstrapError
      ? error.code
      : 'PLATFORM_ADMIN_BOOTSTRAP_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
