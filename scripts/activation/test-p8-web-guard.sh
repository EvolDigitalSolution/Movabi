#!/usr/bin/env bash
# Isolated fake-Docker regression of the actual shipped verifier; no host access/container changes.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/tools" "$T/html"
cp "$root/deploy/vaydu-develop-activation/verify-p8-web.sh" "$T/tools/"
printf 'approved index\n' > "$T/html/index.html"
printf 'approved script\n' > "$T/html/main.js"
(cd "$T/html"; sha256sum ./index.html ./main.js) > "$T/tools/P8_WEB_f949a14_SHA256SUMS"
printf './index.html\n./main.js\n' > "$T/tools/P8_WEB_f949a14_FILES.txt"
cat > "$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
 ps) echo abc ;;
 inspect) case "$3" in
   '{{.Config.Image}}') echo "${TEST_TAG:-movabi-web:release-f949a14-linux}" ;;
   '{{.Image}}') echo sha256:running ;;
   '{{.Id}}') echo abcfull ;;
   *) exit 91 ;;
 esac ;;
 image) echo "${TEST_TAG_ID:-sha256:running}" ;;
 exec) cd "$TEST_HTML"; if [[ "$*" = *sha256sum* ]]; then sha256sum -c; else find . ! -type d | LC_ALL=C sort; fi ;;
 *) exit 92 ;;
esac
FAKE
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" TEST_HTML="$T/html"
run(){ mkdir "$T/$1"; bash "$T/tools/verify-p8-web.sh" "$T/$1" > "$T/$1/output.log" 2>&1; }
reject(){ if run "$1"; then echo "FAIL: accepted $1"; exit 1; fi; echo "PASS: rejects $1"; }
run good
[[ "$(cat "$T/good/web-image-id.txt")" = sha256:running && "$(cat "$T/good/web-container-id.txt")" = abcfull ]]
echo 'PASS: exact baseline payload accepted and actual image/container IDs recorded'
TEST_TAG=movabi-web:release-3c91991 reject old-baseline-tag
TEST_TAG_ID=sha256:retagged reject tag-image-id-drift
printf 'modified\n' > "$T/html/main.js"; reject changed-content
printf 'approved script\n' > "$T/html/main.js"
mv "$T/html/main.js" "$T/main.js"; reject missing-file; mv "$T/main.js" "$T/html/main.js"
touch "$T/html/extra.js"; reject extra-file
echo 'P8_WEB_GUARD_REGRESSIONS_OK: 6 cases'
