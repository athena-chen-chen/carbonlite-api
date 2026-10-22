// Executes the actual forward SQL against session-local copies, never live library rows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { PrismaClient } from '@prisma/client';

const root = new URL('../', import.meta.url);
const env = parseEnv(readFileSync(new URL('.env.local', root), 'utf8'));
const url = new URL(env.DATABASE_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Requires local PostgreSQL');
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const old = 'CarbonLite MVP Default Factors v1.0';
const current = 'CarbonLite Default Factor Library v1.0';
const sql = readFileSync(new URL('prisma/migrations/20261018010000_rename_internal_factor_library/migration.sql', root), 'utf8');
const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
const library = ['ConversionFactor', 'FactorSource'];
const historical = ['ActivityData', 'SpreadsheetImportReviewRow', 'MetricResult', 'FactorVersion', 'AuditLog'];
async function fingerprints(tx) {
  const result = {};
  for (const table of [...library, ...historical]) {
    result[table] = await tx.$queryRawUnsafe(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id)::text, '')) AS hash FROM public."${table}" t`);
  }
  return result;
}
try {
  await prisma.$transaction(async tx => {
    const original = await fingerprints(tx);
    for (const table of library) {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${table}" ON COMMIT DROP AS SELECT * FROM public."${table}"`);
      const [template] = await tx.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM pg_temp."${table}" t LIMIT 1`);
      assert(template, `Need one local ${table} row for full-schema fixtures`);
      for (const [index, document] of [old, current, 'Customer reference', old + ' supplement', null].entries()) {
        if (table === 'FactorSource' && document === null) continue;
        const fixture = { ...template.row, id: `rename-test-${index}`, sourceDocument: document };
        await tx.$executeRawUnsafe(`INSERT INTO pg_temp."${table}" SELECT * FROM jsonb_populate_record(NULL::pg_temp."${table}", $1::jsonb)`, JSON.stringify(fixture));
      }
    }
    const read = async () => Object.fromEntries(await Promise.all(library.map(async table => [table, await tx.$queryRawUnsafe(`SELECT * FROM pg_temp."${table}" ORDER BY id`)])));
    const before = await read();
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    const once = await read();
    for (const table of library) {
      assert.deepEqual(once[table], before[table].map(row => ({ ...row, sourceDocument: row.sourceDocument === old ? current : row.sourceDocument })), `${table}: only exact sourceDocument changes`);
      assert(!once[table].some(row => row.sourceDocument === old));
    }
    for (const statement of statements) assert.equal(await tx.$executeRawUnsafe(statement), 0, 'Second execution updates zero rows');
    assert.deepEqual(await read(), once, 'Idempotent; all semantic fields and timestamps unchanged');
    assert.deepEqual(await fingerprints(tx), original, 'All public library and historical tables unchanged');
  }, { timeout: 30000 });
  console.log('PASS: exact matches renamed in both full-schema table copies; unrelated/null/prefix values preserved; all other fields unchanged; idempotent; public library and historical data unchanged.');
} finally {
  await prisma.$disconnect();
}
