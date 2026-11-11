#!/usr/bin/env bash
# Builds the develop release bundle for the driver top-up verify fix, in the layout
# rollout-develop-52097ef.sh expects. Run from the repo root in Git Bash AFTER the fix
# is committed and AFTER `npm run build:mobile:develop` succeeded on that commit.
# It never deploys anything.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse --short=7 HEAD)
NAME="vaydu-develop-${SHA}-topup"
OUT="release/${NAME}"
PATHS=(server src/app/shared deploy/vaydu-payment-account-setup/api package.json package-lock.json)
FIX=deploy/vaydu-topup-verify-fix

# 1. Source must be exactly the committed tree (no uncommitted edits in shipped paths).
if [ -n "$(git status --porcelain -- "${PATHS[@]}")" ]; then
  echo "FATAL: uncommitted changes in shipped paths:"; git status --short -- "${PATHS[@]}"; exit 1; fi
# 2. The fix must be in this commit.
grep -q "async discard(" server/services/payments/driver-wallet-topup.ts || { echo "FATAL: fix not present in HEAD"; exit 1; }
# 3. Mobile build must exist and be newer than the commit.
[ -f dist/mobile/browser/index.html ] || { echo "FATAL: run npm run build:mobile:develop first"; exit 1; }
COMMIT_TS=$(git log -1 --format=%ct); BUILD_TS=$(stat -c %Y dist/mobile/browser/index.html)
[ "$BUILD_TS" -ge "$COMMIT_TS" ] || { echo "FATAL: dist/mobile is older than HEAD; rebuild"; exit 1; }
grep -rlq "Discard this unpaid attempt" dist/mobile/browser || { echo "FATAL: mobile build does not contain the fixed top-up component"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/mobile"
# Exact committed bytes: core.autocrlf (default true on Windows) would otherwise make git archive
# rewrite LF files as CRLF, so the bundle would not match the SOURCE_SHA it claims.
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD -- "${PATHS[@]}" | tar -x -C "$OUT"
# Prove it: every extracted file's raw blob id must equal the committed blob id, and no extras.
git ls-tree -r HEAD -- "${PATHS[@]}" | awk '{print $3"\t"$4}' | sort -k2 > "$OUT.expected-blobs"
(cd "$OUT" && find "${PATHS[@]}" -type f | sort > "../$NAME.files" \
  && paste <(tr '\n' '\0' < "../$NAME.files" | xargs -0 git hash-object --no-filters --) "../$NAME.files" | sort -k2) > "$OUT.actual-blobs"
# (paths as arguments: Git for Windows' --stdin-paths ignores --no-filters and re-hashes as CRLF)
cmp -s "$OUT.expected-blobs" "$OUT.actual-blobs" || { echo "FATAL: bundle source differs from HEAD:"; diff "$OUT.expected-blobs" "$OUT.actual-blobs" | head -20; exit 1; }
echo "source files byte-identical to HEAD: $(wc -l < "$OUT.actual-blobs")"
rm -f "$OUT.expected-blobs" "$OUT.actual-blobs" "release/$NAME.files"
cp -r dist/mobile/browser "$OUT/mobile/browser"
for f in VERIFY.sql PREREQ.sql ORDER.txt; do git cat-file -p "HEAD:$FIX/$f" > "$OUT/$f"; done   # committed bytes
git rev-parse --short=7 HEAD > "$OUT/SOURCE_SHA"
(cd "$OUT" && sha256sum VERIFY.sql PREREQ.sql ORDER.txt SOURCE_SHA > SHA256SUMS \
  && find . -type f ! -name SHA256SUMS ! -name ALL_SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > ALL_SHA256SUMS)
(cd release && tar -czf "${NAME}.tar.gz" "$NAME" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256")
echo "Bundle:  release/${NAME}.tar.gz"
cat "release/${NAME}.tar.gz.sha256"
echo "SOURCE_SHA: $SHA"
