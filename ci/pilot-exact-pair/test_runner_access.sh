#!/usr/bin/env bash
# Only a disposable Linux container; no host accounts/files may be changed.
set -euo pipefail
[[ "$(id -u)" = 0 && "${RUNNER_ACCESS_DISPOSABLE_FIXTURE:-}" = synthetic-only ]] || exit 1
reviewed="${1:?Read-only bundle mount required}"
exec python3 -B "$reviewed/ci/pilot-exact-pair/test_runner_permissions.py" "$reviewed"
