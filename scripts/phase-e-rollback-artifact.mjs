// Build an immutable prior source snapshot, never check out/reset the working tree.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const sha = '0498646f5721619f91ee710a89386b4b84aaf329';
if (execFileSync('git', ['cat-file', '-t', sha], { encoding: 'utf8' }).trim() !== 'commit') throw new Error('Prior source object unavailable; no network fallback');
for (const file of ['package.json', 'pnpm-lock.yaml']) {
  const historical = execFileSync('git', ['show', `${sha}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
  if (!historical.equals(readFileSync(file))) throw new Error('Prior artifact dependency/schema contract differs; independent build decision required');
}
const historicalSchema = execFileSync('git', ['show', `${sha}:prisma/schema.prisma`], { encoding: 'utf8' });
const expectedAddition = '  grantGeneration                  Int                   @default(0)\n';
const currentSchema = readFileSync('prisma/schema.prisma', 'utf8');
if (currentSchema.replace(expectedAddition, '') !== historicalSchema || !currentSchema.includes(expectedAddition)) {
  throw new Error('Rollback fixture permits only the reviewed additive grant-generation schema delta');
}
const root = mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'carbonlite-phase-e-rollback-'));
const archive = execFileSync('git', ['archive', sha, 'src', 'tsconfig.json', 'tsconfig.build.json', 'package.json', 'pnpm-lock.yaml', 'prisma/schema.prisma'], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', root], { input: archive });
// Isolate the old generated client: compiling old source against the new client
// would not prove the additive database contract with the actual old model.
const modules = join(root, 'node_modules'); mkdirSync(modules);
for (const name of readdirSync('node_modules')) if (name !== '@prisma') symlinkSync(join(process.cwd(), 'node_modules', name), join(modules, name));
mkdirSync(join(modules, '@prisma'));
for (const name of readdirSync('node_modules/@prisma')) symlinkSync(join(process.cwd(), 'node_modules/@prisma', name), join(modules, '@prisma', name));
writeFileSync(join(root, 'prisma/schema.prisma'), historicalSchema.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "../legacy-client"'));
try { execFileSync('pnpm', ['exec', 'prisma', 'generate', '--schema', join(root, 'prisma/schema.prisma')], { env: { ...process.env, DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/carbonlite_test' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch { throw new Error('Isolated prior Prisma client generation failed; no network or runtime fallback'); }
unlinkSync(join(modules, '@prisma/client')); mkdirSync(join(modules, '@prisma/client'));
// Match the installed package's CommonJS wrapper semantics (the custom generated
// directory itself sets __esModule and cannot replace that wrapper directly).
writeFileSync(join(modules, '@prisma/client/package.json'), JSON.stringify({ name: '@prisma/client', main: 'index.js', types: 'index.d.ts' }));
writeFileSync(join(modules, '@prisma/client/index.js'), "module.exports = { ...require('../../../legacy-client') };\n");
writeFileSync(join(modules, '@prisma/client/index.d.ts'), "export * from '../../../legacy-client';\n");
symlinkSync(join(root, 'legacy-client/runtime'), join(modules, '@prisma/client/runtime'));
try { execFileSync('pnpm', ['exec', 'tsc', '-p', join(root, 'tsconfig.build.json')], { stdio: ['ignore', 'pipe', 'pipe'] }); }
catch { throw new Error('Prior artifact compilation failed; no application or database was started'); }
writeFileSync(join(root, 'artifact-sha'), sha + '\n');
process.stdout.write(root + '\n'); // Non-secret temporary directory only.
