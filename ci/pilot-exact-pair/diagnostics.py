"""Bounded synthetic CI evidence. Never upload raw subprocess output or packet payloads."""
import datetime
import ipaddress
import json
import os
import signal
import subprocess
import threading
from pathlib import Path
import re
import sys

MAX_INPUT = 16 * 1024 * 1024
MAX_TEXT = 8192
MAX_FAILURES = 128
MAX_BYTES = 512 * 1024


def capture(command, cwd, env, raw, timeout=1800, limit=MAX_INPUT):
    """Bound raw output locally; terminate the command group on overflow/timeout."""
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True, umask=0o077)
    overflow = threading.Event()
    def stop():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    def drain():
        total = 0
        try:
            with os.fdopen(os.open(raw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as stream:
                os.chmod(raw, 0o600)
                while chunk := process.stdout.read(4096):
                    remaining = max(0, limit - total)
                    stream.write(chunk[:remaining])
                    total += len(chunk)
                    if total > limit:
                        overflow.set()
                        stop()
                        break
        except Exception:
            overflow.set()
            stop()
        finally:
            process.stdout.close()
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timed_out = False
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        stop()
        code = process.wait(timeout=10)
    reader.join(timeout=5)
    if reader.is_alive():
        stop()
        raise ValueError('Unsettled subprocess output reader')
    return {'exit_code': code, 'output_limit_exceeded': overflow.is_set(), 'timed_out': timed_out}


REDACTED = '[REDACTED]'
STATUS = {'passed', 'failed', 'pending', 'todo', 'disabled', 'skipped'}
MATCHERS = {'toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toHaveLength',
            'toBeTruthy', 'toBeFalsy', 'toBeNull', 'toBeDefined', 'toBeUndefined',
            'toContain', 'toContainEqual', 'toThrow', 'toBeInstanceOf',
            'toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith',
            'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan',
            'toBeLessThanOrEqual', 'toBeCloseTo', 'toMatch'}
ERROR_TYPES = {'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AssertionError',
               'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
               'PrismaClientInitializationError'}
ERROR_CODES = {'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
               'P1000', 'P1001', 'P1002', 'P1008', 'P1010', 'P1017', 'P2002',
               'P2003', 'P2025', 'P2028', 'P2034'}
STAGES = {'prisma-generation', 'database-identity', 'disposable-migrate', 'disposable-seed',
          'backend-units', 'backend-types', 'backend-build', 'backend-e2e-postgres',
          'backend-e2e-pgbouncer', 'frontend-script-tests', 'frontend-vitest',
          'frontend-types', 'frontend-build', 'frontend-test-types', 'no-new-diagnostics'}


def sanitize(_value):
    """Unknown text has no safe passthrough, including short or nested values."""
    return REDACTED


def trusted_files(root):
    """Source paths only, from the identity-verified checkout, never Jest payloads."""
    raw = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root)
    if len(raw) > MAX_INPUT:
        raise ValueError('Source inventory exceeds budget')
    result = {s for s in raw.decode('utf-8').split('\0') if safe_relative(s)}
    if not result:
        raise ValueError('Missing trusted source inventory')
    return result


def safe_relative(value):
    return (isinstance(value, str) and value.isascii() and len(value) <= 256
            and re.fullmatch(r'(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:ts|tsx|js|jsx|mjs|cjs)', value) is not None
            and '..' not in Path(value).parts)


def source_path(value, root, allowed):
    if not isinstance(value, str) or not value.isascii() or any(ord(c) < 32 for c in value):
        return None
    path = Path(value)
    if '..' in path.parts:
        return None
    if path.is_absolute():
        if root is None:
            return None
        try:
            value = path.relative_to(Path(root)).as_posix()
        except ValueError:
            return None
    if safe_relative(value) and value in allowed:
        return value
    return None


def source_location(path, line, column, root):
    if root is None:
        return None
    source = Path(root) / path
    try:
        if source.resolve(strict=True) != Path(root).resolve() / path or source.is_symlink() or source.stat().st_size > MAX_INPUT:
            return None
        lines = source.read_text(encoding='utf-8').splitlines()
        # JS source columns are UTF-16 code units, not arbitrary payload numbers.
        if not 1 <= line <= len(lines) or not 1 <= column <= len(lines[line - 1].encode('utf-16-le')) // 2 + 1:
            return None
    except (OSError, UnicodeError):
        return None
    return {'file': path, 'line': line, 'column': column}


def scalar(value):
    # Full-string grammars only. Strings, compound values, NaN and infinities omitted.
    if value in {'true', 'false', 'null'}:
        return {'true': True, 'false': False, 'null': None}[value]
    if len(value) <= 64 and re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', value):
        result = json.loads(value)
        if isinstance(result, float) and not __import__('math').isfinite(result):
            return REDACTED
        return result
    return REDACTED


def failure_text(value, root=None, allowed=frozenset()):
    """Return parsed fields only; never echo a line or recursively copy input JSON."""
    result = {'assertions': [], 'matchers': [], 'error_codes': [],
              'source_locations': [], 'redaction_marker': REDACTED, 'redacted': 0, 'truncated': False}
    if not isinstance(value, str):
        result['redacted'] = 1  # Nested errors/causes/JSON are deliberately excluded.
        return result
    if len(value) > MAX_TEXT:
        result['truncated'] = True
    for raw in value[:MAX_TEXT].split('\n'):
        # Strip only conventional ANSI color codes. Other controls/Unicode redact.
        line = re.sub(r'\x1b\[[0-9;]*m', '', raw)
        if not line.isascii() or any(ord(c) < 32 for c in line):
            result['redacted'] += 1
            continue
        line = line.strip()
        if not line:
            continue
        assertion = re.fullmatch(r'(Expected|Received|Expected length|Received length|Expected number of calls|Received number of calls|Number of calls): *(.*)', line)
        if assertion:
            parsed = scalar(assertion[2])
            result['assertions'].append({'field': assertion[1], 'value': parsed})
            result['redacted'] += parsed == REDACTED
            continue
        matcher = re.fullmatch(r'expect\(received\)\.(?:(not|resolves|rejects)\.)?(\w+)\((?:expected)?\)', line)
        if matcher and matcher[2] in MATCHERS:
            result['matchers'].append({'category': matcher[2], 'modifier': matcher[1]})
            continue
        error = re.fullmatch(r'([A-Za-z]+): *([A-Z][A-Z0-9]+)(?::.*)?', line)
        if error and error[1] in ERROR_TYPES and error[2] in ERROR_CODES:
            result['error_codes'].append(error[2])
            # All trailing prose is discarded, even when the code is recognized.
            continue
        # Frame label/function text is discarded. Only a trusted source path and
        # bounded positive line/column numbers can become artifact fields.
        frame = re.fullmatch(r'at (?:.*\()?([^\s()]+):([1-9][0-9]{0,6}):([1-9][0-9]{0,5})\)?', line)
        if frame:
            path = source_path(frame[1], root, allowed)
            location = source_location(path, int(frame[2]), int(frame[3]), root) if path else None
            if location:
                result['source_locations'].append(location)
                continue
        result['redacted'] += 1
    return result


def write_bounded(path, payload):
    encoded = json.dumps(payload, indent=2, allow_nan=False).encode()
    if len(encoded) > MAX_BYTES:
        raise ValueError('Sanitized diagnostic budget exceeded')
    Path(path).write_bytes(encoded)


COUNT_FIELDS = ('numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numFailedTestSuites')


def safe_counts(data):
    if not isinstance(data, dict) or any(type(data.get(key)) is not int or data[key] < 0 for key in COUNT_FIELDS):
        raise ValueError('Unverifiable test counts')
    return {key: data[key] for key in COUNT_FIELDS}


def suite_summaries(data, root, allowed):
    if not isinstance(data, dict) or not isinstance(data.get('testResults'), list):
        raise ValueError('Missing test suite evidence')
    result = []
    for suite in data['testResults']:
        path = source_path(suite.get('name'), root, allowed)
        if path is None or suite.get('status') not in STATUS:
            raise ValueError('Unverifiable suite identity/status')
        result.append({'file': path, 'status': suite['status']})
    return result


def jest_evidence(source, destination, root=None, allowed=frozenset()):
    source = Path(source)
    if source.stat().st_size > MAX_INPUT:
        raise ValueError('Jest JSON exceeds evidence input budget')
    data = json.loads(source.read_text())
    summaries = suite_summaries(data, root, allowed)
    suites, failures = [], []
    observed_failed = 0
    for suite, summary in zip(data['testResults'], summaries):
        assertions = suite.get('assertionResults')
        if not isinstance(assertions, list):
            raise ValueError('Malformed Jest suite evidence')
        suites.append({**summary, 'message': failure_text(suite.get('message', ''), root, allowed),
                       'outcome_kind': 'TEST_INFRASTRUCTURE_FAILURE' if suite['status'] == 'failed' and not any(t.get('status') == 'failed' for t in assertions) else 'TEST_RESULT'})
        for index, test in enumerate(assertions, 1):
            if test.get('status') not in STATUS:
                raise ValueError('Unverifiable assertion status')
            if test['status'] != 'failed':
                continue
            observed_failed += 1
            if observed_failed > MAX_FAILURES:
                raise ValueError('Failure count exceeds evidence budget')
            messages = test.get('failureMessages', [])
            if not isinstance(messages, list) or len(messages) > 8:
                raise ValueError('Malformed or over-budget failure messages')
            # Never retain title, ancestorTitles, fullName, failureDetails or causes.
            # Ordinal + trusted file + exact candidate SHA is a reproducible identity.
            failures.append({**summary, 'identity': {'assertion_index': index},
                             'name': REDACTED, 'status': 'failed', 'outcome_kind': 'TEST_FAILURE',
                             'messages': [failure_text(x, root, allowed) for x in messages]})
    count = data.get('numFailedTests')
    if type(count) is not int or count != observed_failed:
        raise ValueError('Failed-test evidence count mismatch')
    result = {'format': 2, 'raw_test_exit_is_unchanged': True,
              'failed_test_count': observed_failed,
              'identity_policy': 'trusted repository file + assertion ordinal; dynamic names omitted',
              'suites': suites, 'failures': failures}
    write_bounded(destination, result)
    return result


def vitest_evidence(source, destination, root, allowed, approved):
    """Vitest 4.1.6 JSON only: never copy titles, meta, values, or raw prose."""
    sha, tree = approved.get('expected_commit'), approved.get('expected_tree')
    if any(not isinstance(x, str) or not re.fullmatch(r'[0-9a-f]{40}', x) for x in (sha, tree)):
        raise ValueError('Missing approved frontend identity')
    for expression, expected in [('HEAD', sha), ('HEAD^{tree}', tree)]:
        if subprocess.check_output(['git', 'rev-parse', expression], cwd=root).decode().strip() != expected:
            raise ValueError('Frontend identity mismatch')
    source = Path(source)
    if source.stat().st_size > MAX_INPUT:
        raise ValueError('Vitest evidence exceeds input budget')
    data = json.loads(source.read_text())
    counts = safe_counts(data)
    summaries = suite_summaries(data, root, allowed)
    failures, suites = [], []
    observed = 0
    for suite, summary in zip(data['testResults'], summaries):
        # Also reject tracked symlinks and nonexistent source files.
        if source_location(summary['file'], 1, 1, root) is None:
            raise ValueError('Unverifiable Vitest source boundary')
        assertions = suite.get('assertionResults')
        if not isinstance(assertions, list):
            raise ValueError('Missing Vitest assertions')
        suites.append({**summary, 'classification': 'unknown' if summary['status'] == 'failed' else None})
        for ordinal, test in enumerate(assertions, 1):
            if not isinstance(test, dict) or test.get('status') not in STATUS:
                raise ValueError('Malformed Vitest assertion')
            if test['status'] != 'failed':
                continue
            observed += 1
            if observed > MAX_FAILURES:
                raise ValueError('Vitest failure budget exceeded')
            messages = test.get('failureMessages', [])
            if (not isinstance(messages, list) or len(messages) > 8
                    or any(not isinstance(m, str) or len(m) > MAX_TEXT for m in messages)):
                raise ValueError('Malformed or oversized Vitest failure metadata')
            duration = test.get('duration')
            if duration is not None and (type(duration) not in (int, float)
                    or not __import__('math').isfinite(duration) or not 0 <= duration <= 1800000):
                raise ValueError('Invalid Vitest duration')
            locations, operators, timeout = [], [], None
            for message in messages:
                # Reuse trusted frame parsing, but discard its scalar/text fields.
                for location in failure_text(message, root, allowed)['source_locations']:
                    if location['file'] == summary['file'] and location not in locations:
                        locations.append(location)
                for raw in message.splitlines():
                    line = re.sub(r'\x1b\[[0-9;]*m', '', raw).strip()
                    matcher = re.fullmatch(r'expect\(received\)\.(?:(?:not|resolves|rejects)\.)?(\w+)\((?:expected)?\)', line)
                    if matcher and matcher[1] in MATCHERS and matcher[1] not in operators:
                        operators.append(matcher[1])
                    explicit = re.fullmatch(r'Error: (Test|Hook) timed out in ([1-9][0-9]{0,6})ms\.', line)
                    if explicit and int(explicit[2]) <= 1800000:
                        timeout = {'kind': explicit[1].lower(), 'limit_ms': int(explicit[2]),
                                   'evidence': 'explicit_reporter_message'}
            declaration = test.get('location')
            test_location = None
            if isinstance(declaration, dict) and all(type(declaration.get(k)) is int for k in ('line', 'column')):
                test_location = source_location(summary['file'], declaration['line'], declaration['column'], root)
            failures.append({'file': summary['file'], 'assertion_ordinal': ordinal,
                             'classification': 'timeout' if timeout else 'assertion' if operators else 'unknown',
                             'duration_ms': duration, 'timeout': timeout,
                             'test_location': test_location, 'reported_source_locations': locations,
                             'operators': operators, 'details_available': bool(locations or operators or timeout or test_location),
                             'expected_actual': 'unavailable'})
    if observed != counts['numFailedTests']:
        raise ValueError('Vitest failure count mismatch')
    result = {'format': 1, 'frontend_commit': sha, 'frontend_tree': tree,
              'raw_test_exit_is_unchanged': True, 'failed_test_count': observed,
              'identity_policy': 'trusted file + assertion ordinal; titles omitted',
              'unhandled_error_details': 'unavailable_in_vitest_4_1_6_json',
              'suites': suites, 'failures': failures}
    write_bounded(destination, result)
    return result


def network_evidence(lines, since_us, stages=None):
    """Parse only our header-only kernel LOG records; never emit raw journal data."""
    events = []
    for line in lines:
        entry = json.loads(line)
        message = entry.get('MESSAGE', '')
        if 'CLPAIR_DENY ' not in message:
            continue
        timestamp = int(entry['__REALTIME_TIMESTAMP'])
        if timestamp < since_us:
            continue
        fields = dict(re.findall(r'\b(DST|DPT|PROTO|UID)=([^\s]+)', message))
        if fields.get('UID') != '24001':
            continue
        address = ipaddress.ip_address(fields['DST'])
        port = int(fields['DPT']) if 'DPT' in fields else None
        if port is not None and not 0 <= port <= 65535:
            raise ValueError('Invalid destination port')
        protocol = fields.get('PROTO', 'UNKNOWN')
        if protocol not in ['TCP', 'UDP', 'ICMP', 'ICMPv6', '58', '2']:
            protocol = 'OTHER'
        classification = ('DNS_ATTEMPT' if port == 53 else
                          'UNEXPECTED_LOOPBACK' if address.is_loopback else
                          'RESERVED_TEST_DESTINATION' if address in ipaddress.ip_network('192.0.2.0/24') else
                          'OTHER_BLOCKED_DESTINATION')
        event = {'utc': datetime.datetime.fromtimestamp(timestamp / 1e6, datetime.timezone.utc).isoformat(),
                 'destination': str(address), 'port': port, 'protocol': protocol,
                 'classification': classification, 'uid': 24001,
                 'process': 'UID attribution only; PID/executable/test unavailable',
                 'provider': 'UNVERIFIED; IP/port alone cannot identify provider'}
        if stages:
            if any(s.get('stage') not in STAGES or type(s.get('started_us')) is not int or ('finished_us' in s and type(s['finished_us']) is not int) for s in stages):
                raise ValueError('Unverifiable stage metadata')
            event['overlapping_stages'] = [s['stage'] for s in stages if s['started_us'] <= timestamp <= s.get('finished_us', 2**63)]
        events.append(event)
        if len(events) > 128:
            raise ValueError('Kernel diagnostic event budget exceeded')
    return {'events': events, 'attribution': 'rate-limited header-only kernel evidence; not per-test attribution',
            'allowed_traffic': 'loopback and inspected disposable database TCP/5432 bypass denial logging'}


if __name__ == '__main__':
    # Journal input is bounded upstream. A failed parser must not imply zero traffic.
    try:
        if sys.argv[1] != 'network':
            raise ValueError('Unknown evidence mode')
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError('Journal evidence input budget exceeded')
        stages = json.loads(Path(sys.argv[4]).read_text()) if Path(sys.argv[4]).exists() else None
        result = network_evidence(raw.decode().splitlines(), int(sys.argv[2]), stages)
        counter = Path(sys.argv[5]).read_text().strip()
        match = re.fullmatch(r'BLOCKED_EXTERNAL_PACKETS: ([0-9]+)', counter)
        if not match:
            raise ValueError('Missing network counter evidence')
        result['blocked_packet_count'] = int(match.group(1))
        result['logged_event_count'] = len(result['events'])
        result['coverage'] = ('COUNTS_AGREE; UID/stage correlation only' if len(result['events']) == result['blocked_packet_count']
                              else 'PARTIAL_OR_UNAVAILABLE; rate limit/journal retention may omit events')
        write_bounded(sys.argv[3], result)
    except Exception:
        print('SANITIZED_DIAGNOSTICS: BLOCKED', file=sys.stderr)
        raise SystemExit(1)
