#!/usr/bin/env bash
# Public reviewed CI source only. Never grant write access or recurse with chmod.
set -euo pipefail
workspace="${1:?Exact absolute GITHUB_WORKSPACE required}"
runner_uid="${2:?Trusted Actions runner UID required}"
runner_gid="${3:?Trusted Actions runner primary GID required}"
permission_guard="$(dirname -- "${BASH_SOURCE[0]}")/runner-permissions.py"
# Establish mode/owner/ACL and namespace safety BEFORE any privileged chmod.
before="$(python3 "$permission_guard" "$workspace" "$runner_uid" "$runner_gid")"
user=clpairtest
[[ "$(id -u "$user")" = 24001 ]] || { echo 'RUNNER_ACCESS: BLOCKED wrong test UID'; exit 1; }
[[ "$workspace" = /* && "$(realpath -e -- "$workspace")" = "$workspace" ]] || { echo 'RUNNER_ACCESS: BLOCKED noncanonical workspace'; exit 1; }
if [[ "$(id -u)" = 0 ]]; then
  as_user=(runuser -u "$user" --)
  as_root=()
else
  as_user=(sudo -H -u "$user" --)
  as_root=(sudo --)
fi

# Enumerate every ancestor: checking the leaf alone cannot identify a blocked parent.
directories=()
path="$workspace"
while :; do
  directories=("$path" "${directories[@]}")
  [[ "$path" = / ]] && break
  path="$(dirname -- "$path")"
done
control_directories=("$workspace/control" "$workspace/control/ci" "$workspace/control/ci/pilot-exact-pair")
directories+=("${control_directories[@]}")
files=("$workspace/control/ci/pilot-exact-pair/diagnostics.py"
       "$workspace/control/ci/pilot-exact-pair/run.py"
       "$workspace/control/ci/pilot-exact-pair/type_debt.py"
       "$workspace/control/ci/pilot-exact-pair/approved.json")
# Fail before repairs on missing/nonregular/symlinked evidence.
for path in "${directories[@]}"; do
  [[ -d "$path" && ! -L "$path" ]] || { echo "RUNNER_ACCESS: BLOCKED directory $path"; exit 1; }
done
for path in "${files[@]}"; do
  [[ -f "$path" && ! -L "$path" ]] || { echo "RUNNER_ACCESS: BLOCKED file $path"; exit 1; }
done

# Select the POSIX class that actually governs this UID; an owning group with
# no search/read permission takes precedence over otherwise usable other bits.
grant_access() {
  local bit="$1" target="$2" class=o owner group
  owner="$(stat -c %u -- "$target")"
  group="$(stat -c %g -- "$target")"
  if [[ "$owner" = 24001 ]]; then
    class=u
  elif [[ " $(id -G "$user") " = *" $group "* ]]; then
    class=g
  fi
  "${as_root[@]}" chmod "${class}+${bit}" -- "$target"
}

# Log the exact component that denies the actual test UID, before changing it.
# +x grants search only (no listing/write); +r grants reading only public CI code.
# Only the governing POSIX class changes; every write bit is preserved. ACL denials
# are not overridden: the post-check still fails closed if POSIX bits cannot fix it.
for path in "${directories[@]}"; do
  if ! "${as_user[@]}" test -x "$path"; then
    echo "RUNNER_ACCESS: MISSING_SEARCH $path"
    grant_access x "$path"
  fi
  "${as_user[@]}" test -x "$path" || { echo "RUNNER_ACCESS: BLOCKED search $path"; exit 1; }
done
for path in "${files[@]}"; do
  if ! "${as_user[@]}" test -r "$path"; then
    echo "RUNNER_ACCESS: MISSING_READ $path"
    grant_access r "$path"
  fi
  "${as_user[@]}" test -r "$path" || { echo "RUNNER_ACCESS: BLOCKED read $path"; exit 1; }
  # Actually open/read as clpairtest; do not rely on mode-bit inspection alone.
  "${as_user[@]}" cat -- "$path" >/dev/null
  if "${as_user[@]}" test -w "$path"; then
    echo "RUNNER_ACCESS: BLOCKED writable control file $path"; exit 1
  fi
done
for path in "${directories[@]}"; do
  if "${as_user[@]}" test -w "$path"; then
    echo "RUNNER_ACCESS: BLOCKED writable control directory $path"; exit 1
  fi
done
after="$(python3 "$permission_guard" "$workspace" "$runner_uid" "$runner_gid")"
[[ "$before" = "$after" ]] || { echo 'RUNNER_ACCESS: BLOCKED control namespace/content changed'; exit 1; }
echo 'RUNNER_ACCESS: PASS uid=24001; mode/owner/ACL safe; traversal/read verified; control write denied'
