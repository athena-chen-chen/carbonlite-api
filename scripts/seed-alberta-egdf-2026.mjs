import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from './dev-database.mjs';
import { assertEgdfDevelopmentTarget, seedAlbertaEgdf2026 } from '../prisma/library/alberta-egdf-2026.ts';

async function main() {
  const { env } = loadEnvironment('neon');
  const flag = '--confirmed-development-endpoint=';
  const confirmedEndpoint = process.argv.slice(2).find(arg => arg.startsWith(flag))?.slice(flag.length);
  assertEgdfDevelopmentTarget(env, confirmedEndpoint);
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedAlbertaEgdf2026(prisma);
    console.log(JSON.stringify({ target: 'Neon development', ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  // Prisma errors may include connection details; only our fixed safety errors
  // and a safe error code are reported.
  console.error(error?.message?.startsWith('Refusing data load:') ||
    error?.message === 'A different record already uses the official factor name; review it before loading.'
    ? error.message : `Official factor load failed (${error?.code ?? 'configuration or connection error'}).`);
  process.exitCode = 1;
});
