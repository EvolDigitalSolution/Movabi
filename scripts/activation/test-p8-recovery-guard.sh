#!/usr/bin/env bash
# Fail-closed recovery regressions. Fake Docker is never allowed to mutate a container.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/tools" "$T/evidence"
cp "$root/deploy/vaydu-develop-activation/recover-p8-api.sh" "$T/tools/"
printf 'fixture\n' > "$T/tools/marker"
(cd "$T/tools"; sha256sum marker) > "$T/tools/P8_SHA256SUMS"
printf 'f949a14\n' > "$T/evidence/api-before-source.txt"
printf 'movabi-develop\n' > "$T/evidence/api-project.txt"
printf '/srv/movabi/develop\n' > "$T/evidence/api-workdir.txt"
cat > "$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = exec ]]; then
 cat >/dev/null
 if [[ "${DB_FAIL:-0}" = 1 ]]; then echo 'UNEXPECTED DATABASE FAILURE' >&2; exit 23; fi
 echo 1; exit 0
fi
echo 'MUTATION_OR_UNEXPECTED_DOCKER_CALL' >> "$MUTATIONS"; exit 99
FAKE
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" MUTATIONS="$T/mutations"
reject(){ if bash "$T/tools/recover-p8-api.sh" "$T/evidence" > "$T/$1.log" 2>&1; then echo "FAIL: accepted $1"; exit 1; fi; grep -Fq "$2" "$T/$1.log"; [[ ! -e "$MUTATIONS" ]]; echo "PASS: $1 fails without any Docker mutation"; }
reject committed-activation 'GB binding has committed'
DB_FAIL=1 reject database-error 'UNEXPECTED DATABASE FAILURE'
printf 'production\n' > "$T/evidence/api-project.txt"
reject wrong-project 'recovery identity mismatch'
echo 'P8_RECOVERY_GUARD_REGRESSIONS_OK: 3 cases'
