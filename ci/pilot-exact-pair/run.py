"""Run approved commands with synthetic-only environment; upload summaries, not raw logs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from diagnostics import jest_evidence, capture, failure_text, write_bounded, trusted_files, suite_summaries, STAGES, safe_counts
from type_debt import execute as check_type_debt

workspace = Path(sys.argv[1]).resolve()
web, api = workspace / 'carbonlite-web', workspace / 'carbonlite-api'
output = workspace / 'pair-results' / 'validation'
output.mkdir(parents=True, exist_ok=True)
# Explicit allowlist: no runner tokens, provider keys, telemetry or production env.
env = {'PATH': os.environ['PATH'], 'CI': 'true', 'APP_ENV': 'test', 'NODE_ENV': 'test',
       'DATABASE_URL': 'postgresql://postgres:postgres@127.0.0.1:55447/carbonlite_ci_test',
       'CONTROL_POOL_PGBOUNCER_TEST_URL': 'postgresql://postgres:postgres@127.0.0.1:55448/carbonlite_ci_test',
       'CONTROL_POOL_TEST_POOLER_HOST': 'pgbouncer',
       'CONTROL_POOL_TEST_POSTGRES_CONTAINER': os.environ['POSTGRES_CONTAINER'],
       'FRONTEND_URL': 'http://127.0.0.1:4173', 'CORS_ALLOWED_ORIGINS': 'http://127.0.0.1:4173',
       'JWT_SECRET': 'synthetic-exact-pair-ci-only', 'PUBLIC_REGISTRATION_ENABLED': 'true',
       'REAL_DATA_EVIDENCE_HMAC_ACTIVE_VERSION': 'ci-v1',
       'REAL_DATA_EVIDENCE_HMAC_ADDITIONAL_KEYS': '{"ci-v1":"base64:Q0FSQk9OTElURV9ESVNQT1NBQkxFX0NJX09OTFlfS0VZX1Yx"}',
       'DOCUMENT_STORAGE_PATH': str(output / 'disposable-documents'), 'DOCUMENT_STORAGE_DURABLE': 'true',
       'CARBONLITE_API_DIR': str(api), 'CARBONLITE_API_SOURCE_DIR': str(api),
       'VITE_GA_MEASUREMENT_ID': '', 'VITE_POSTHOG_KEY': '', 'VITE_SENTRY_DSN': ''}
results = json.loads((output / 'tests.json').read_text()) if (output / 'tests.json').exists() else []


def run(label, args, cwd, *, database=None, test_json=False):
    if label not in STAGES:
        raise ValueError('Unknown validation stage')
    allowed = trusted_files(cwd)
    local_env = dict(env)
    if database:
        local_env['DATABASE_URL'] = database
    raw = output / (label + '.raw.log')
    json_path = output / (label + '.raw.json')
    command = list(args)
    if test_json:
        command += [('--reporter=json' if 'vitest' in command else '--json'), '--outputFile=' + str(json_path)]
    stage_path = output / 'stage-intervals.json'
    intervals = json.loads(stage_path.read_text()) if stage_path.exists() else []
    intervals.append({'stage': label, 'started_us': time.time_ns() // 1000})
    stage_path.write_text(json.dumps(intervals, indent=2))
    result = capture(command, cwd, local_env, raw)
    intervals[-1]['finished_us'] = time.time_ns() // 1000
    stage_path.write_text(json.dumps(intervals, indent=2))
    item = {'stage': label, **result, 'outcome_kind': 'TEST_INFRASTRUCTURE_FAILURE' if result['timed_out'] or result['output_limit_exceeded'] else 'COMMAND_RESULT', 'status': 'PASS' if result['exit_code'] == 0 and not result['output_limit_exceeded'] and not result['timed_out'] else 'FAIL'}
    # Persist the raw command status even if parsing/evidence generation fails.
    results.append(item)
    (output / 'tests.json').write_text(json.dumps(results, indent=2))
    if test_json:
        try:
            if 'jest' in command:
                jest_evidence(json_path, output / (label + '.failures.json'), cwd, allowed)
            if json_path.stat().st_size > 16 * 1024 * 1024:
                raise ValueError('Test evidence exceeds input budget')
            data = json.loads(json_path.read_text())
            item['counts'] = safe_counts(data)
            item['suites'] = suite_summaries(data, cwd, allowed)
            if item['counts']['numFailedTests'] or item['counts']['numFailedTestSuites']:
                item['status'] = 'FAIL'
        except Exception:
            item['diagnostics'] = 'FAIL'
            (output / 'tests.json').write_text(json.dumps(results, indent=2))
            # Evidence failure also blocks; preserve the actual command exit above.
            fallback = [line for line in raw.read_text(errors='replace').splitlines()
                        if re.match(r'^\s*(?:Error:|FAIL |at )', line)][:32]
            write_bounded(output / (label + '.failures.json'),
                          {'evidence': 'BLOCKED: missing, malformed or over-budget test evidence',
                           'exit_code': result['exit_code'],
                           'outcome_kind': 'DIAGNOSTIC_FAILURE',
                           'command_outcome': 'TEST_INFRASTRUCTURE_FAILURE' if result['timed_out'] or result['output_limit_exceeded'] else 'UNCLASSIFIED_COMMAND_RESULT',
                           'sanitized_error_frames': [failure_text(line, cwd, allowed) for line in fallback]})
            raise RuntimeError('Test diagnostic evidence unavailable')
    (output / 'tests.json').write_text(json.dumps(results, indent=2))
    print(label + ': ' + item['status'], flush=True)
    if item['status'] != 'PASS':
        raise RuntimeError('Validation stage failed: ' + label)
    return result


try:
    # Generate before network denial: Prisma may need its pinned engine package.
    if sys.argv[2] == 'generate':
        run('prisma-generation', ['pnpm', 'exec', 'prisma', 'generate'], api)
    elif sys.argv[2] == 'validate':
        # Both direct and pooled connections must identify the disposable database.
        js = """const {PrismaClient}=require('@prisma/client');(async()=>{for(const url of [process.env.DATABASE_URL,process.env.CONTROL_POOL_PGBOUNCER_TEST_URL]){const p=new PrismaClient({datasources:{db:{url}}});try{const r=await p.$queryRawUnsafe(\"SELECT current_database() AS db, (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables\");if(r.length!==1||r[0].db!=='carbonlite_ci_test'||r[0].tables!==0)throw Error('Target mismatch');}finally{await p.$disconnect();}}console.log('DISPOSABLE_DATABASE_IDENTITY: PASS');})().catch(()=>{process.exitCode=1});"""
        run('database-identity', ['node', '-e', js], api)
        run('disposable-migrate', ['pnpm', 'exec', 'prisma', 'migrate', 'deploy'], api)
        run('disposable-seed', ['pnpm', 'seed'], api)
        run('backend-units', ['pnpm', 'exec', 'jest', '--config', 'jest.unit.json', '--runInBand'], api, test_json=True)
        run('backend-types', ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'], api)
        run('backend-build', ['pnpm', 'build'], api)
        # Existing immutable rollback fixture; never an application deployment.
        artifact = subprocess.check_output(['node', 'scripts/phase-e-rollback-artifact.mjs'], cwd=api, env=env, timeout=300, stderr=subprocess.DEVNULL).decode().strip()
        marker = Path(artifact) / 'artifact-sha'
        if not Path(artifact).is_dir() or marker.read_text().strip() != '0498646f5721619f91ee710a89386b4b84aaf329':
            raise RuntimeError('Prior fixture identity mismatch')
        env['CARBONLITE_PHASE_E_ROLLBACK_ARTIFACT'] = artifact
        run('backend-e2e-postgres', ['pnpm', 'exec', 'jest', '--config', 'test/jest-e2e.json', '--runInBand'], api, test_json=True)
        # Suites requiring the dedicated direct 55447 port remain in the full run.
        pooled = ['pilot-reporting-scope', 'organization-profile', 'organization-isolation', 'calculation-current-state', 'activity-data-calculation-fields', 'authorization-boundaries']
        run('backend-e2e-pgbouncer', ['pnpm', 'exec', 'jest', '--config', 'test/jest-e2e.json', '--runInBand', *['test/' + name + '.e2e-spec.ts' for name in pooled]], api, database=env['CONTROL_POOL_PGBOUNCER_TEST_URL'], test_json=True)
        run('frontend-script-tests', ['node', '--test', 'scripts/dev-database.test.mjs'], web)
        run('frontend-vitest', ['pnpm', 'exec', 'vitest', 'run', '--maxWorkers=2'], web, test_json=True)
        run('frontend-types', ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.app.json'], web)
        run('frontend-build', ['pnpm', 'build'], web)
        policy = check_type_debt(web, api, output, env,
                                 json.loads(Path(__file__).with_name('approved.json').read_text()))
        results.append({'stage': 'frontend-test-types', 'status': policy['raw_candidate_typecheck'],
                        'exit_code': policy['candidate_compiler']['exit_code'],
                        'diagnostic_count': policy['candidate_count']})
        results.append({'stage': 'no-new-diagnostics', 'status': policy['policy'],
                        'baseline_count': policy['baseline_count'], 'candidate_count': policy['candidate_count']})
        (output / 'tests.json').write_text(json.dumps(results, indent=2))
    else:
        raise RuntimeError('Unknown validation mode')
except SystemExit:
    raise
except Exception:
    print('EXACT_PAIR_VALIDATION: BLOCKED; inspect sanitized stage results.', flush=True)
    raise SystemExit(1)
