/* global console, process */
import { PrismaClient } from '@prisma/client';
import { loadEnvironment } from './dev-database.mjs';
import {
  assertElectricityDevelopmentTarget,
  seedEcccElectricityCanada2026,
} from '../prisma/library/eccc-electricity-canada-2026.ts';

async function main() {
  const { env, summary } = loadEnvironment('neon');
  const flag = '--confirmed-development-endpoint=';
  const confirmedEndpoint = process.argv.slice(2).find((arg) => arg.startsWith(flag))?.slice(flag.length);
  assertElectricityDevelopmentTarget(env, confirmedEndpoint);
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    const result = await seedEcccElectricityCanada2026(prisma);
    console.log(JSON.stringify({ target: summary, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? '');
  const safe = message.startsWith('Refusing') ||
    message.startsWith('A different record already uses') ||
    message.startsWith('Another eligible 2026');
  console.error(safe ? message : `Production factor load failed (${error?.code ?? 'configuration or connection error'}).`);
  process.exitCode = 1;
});
