import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

const RESET_TOKEN_TTL_HOURS = 48;
const DEFAULT_FRONTEND_URL = 'http://localhost:5173';

const prisma = new PrismaClient();

async function main() {
  requireScriptAuthorization();

  const args = parseArgs(process.argv.slice(2));
  const email = args.email.toLowerCase().trim();

  if (!email) {
    throw new Error('Missing required --email argument.');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      email: true,
      isActive: true,
    },
  });

  if (!user || !user.isActive) {
    throw new Error('No active user found for that email address.');
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000,
  );

  await prisma.user.update({
    where: { email },
    data: {
      passwordSetupRequired: true,
      passwordSetupTokenHash: tokenHash,
      passwordSetupTokenExpiresAt: expiresAt,
      passwordSetupTokenUsedAt: null,
    },
  });

  console.log('Password reset link generated.');
  console.log(`Email: ${user.email}`);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`Set password link: ${buildSetPasswordLink(token)}`);
}

function requireScriptAuthorization() {
  if (isLocalDevelopment()) return;

  const token = String(process.env.ADMIN_SCRIPT_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'ADMIN_SCRIPT_TOKEN is required outside local development.',
    );
  }
}

function isLocalDevelopment() {
  const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'local' || nodeEnv === 'test';
}

function parseArgs(args) {
  const parsed = {
    email: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--email') {
      parsed.email = args[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg.startsWith('--email=')) {
      parsed.email = arg.slice('--email='.length);
    }
  }

  return parsed;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function buildSetPasswordLink(token) {
  const frontendUrl = String(
    process.env.FRONTEND_URL || process.env.APP_URL || DEFAULT_FRONTEND_URL,
  ).replace(/\/+$/, '');

  return `${frontendUrl}/set-password?token=${encodeURIComponent(token)}`;
}

main()
  .catch((error) => {
    console.error('Failed to generate password reset link.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
