// Build an immutable prior source snapshot, never check out/reset the working tree.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const sha = '0498646f5721619f91ee710a89386b4b84aaf329';
if (execFileSync('git', ['cat-file', '-t', sha], { encoding: 'utf8' }).trim() !== 'commit') throw new Error('Prior source object unavailable; no network fallback');
for (const file of ['package.json', 'pnpm-lock.yaml', 'prisma/schema.prisma']) {
  const historical = execFileSync('git', ['show', `${sha}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
  if (!historical.equals(readFileSync(file))) throw new Error('Prior artifact dependency/schema contract differs; independent build decision required');
}
const root = mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'carbonlite-phase-e-rollback-'));
const archive = execFileSync('git', ['archive', sha, 'src', 'tsconfig.json', 'tsconfig.build.json', 'package.json', 'pnpm-lock.yaml', 'prisma/schema.prisma'], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', root], { input: archive });
symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'));
try { execFileSync('pnpm', ['exec', 'tsc', '-p', join(root, 'tsconfig.build.json')], { stdio: ['ignore', 'pipe', 'pipe'] }); }
catch { throw new Error('Prior artifact compilation failed; no application or database was started'); }
writeFileSync(join(root, 'artifact-sha'), sha + '\n');
process.stdout.write(root + '\n'); // Non-secret temporary directory only.
