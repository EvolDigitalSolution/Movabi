#!/usr/bin/env bash
# Build the develop release bundle in the layout rollout-develop-52097ef.sh expects (--deploy-api-only /
# --deploy-web-only), plus the database release files. Run from the repo root in Git Bash after
# scripts/release/build-web-linux.sh. Never deploys anything.
#   WEB_BUILD_SHA=<sha of release/linux-build-<sha>> [RELEASE_DIR=deploy/vaydu-develop-release-2] bash deploy/vaydu-develop-release/make-release-bundle.sh
# RELEASE_DIR selects the database release the bundle carries (default: release 1). Its TESTS.txt, when
# present, adds real-DB suites for the host drill.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse --short=7 HEAD)
NAME="vaydu-develop-${SHA}-release-linux"; OUT="release/${NAME}"
REL="${RELEASE_DIR:-deploy/vaydu-develop-release}"; TOOLS=deploy/vaydu-develop-release
# API build inputs, as the running develop API image (no deploy/vaydu-payment-account-setup/api: that
# service is mounted by its own compose override, which the rollout keeps).
PATHS=(server src/app/shared package.json package-lock.json tsconfig.json .dockerignore)
WEB_BUILD_SHA="${WEB_BUILD_SHA:?set WEB_BUILD_SHA to the sha of release/linux-build-<sha>}"
WEB="release/linux-build-${WEB_BUILD_SHA}/out/browser"

# 1. Shipped paths and release files must be exactly the committed tree.
[ -z "$(git status --porcelain -- "${PATHS[@]}" "$REL" "$TOOLS")" ] || { echo "FATAL: uncommitted changes in shipped paths"; git status --short -- "${PATHS[@]}" "$REL"; exit 1; }
# 2. The web build must come from a commit whose web inputs equal HEAD's.
[ -f "$WEB/index.html" ] || { echo "FATAL: $WEB missing; run scripts/release/build-web-linux.sh"; exit 1; }
# src/testing is never part of the web build.
git diff --quiet "$WEB_BUILD_SHA" HEAD -- src ':(exclude)src/testing' angular.json package.json package-lock.json tsconfig.json tsconfig.app.json capacitor.config.ts ionic.config.json \
  || { echo "FATAL: web inputs changed between $WEB_BUILD_SHA and HEAD; rebuild the web"; git diff --stat "$WEB_BUILD_SHA" HEAD -- src angular.json package.json package-lock.json; exit 1; }
# 3. Release SQL must be the generator's output and match its checksums.
(cd "$REL" && sha256sum -c --quiet RELEASE-MIGRATIONS.sha256) || { echo "FATAL: release SQL checksum mismatch"; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/mobile" "$OUT/tests"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD -- "${PATHS[@]}" | tar -x -C "$OUT"
git ls-tree -r HEAD -- "${PATHS[@]}" | awk '{print $3"\t"$4}' | sort -k2 > "$OUT.expected-blobs"
(cd "$OUT" && find "${PATHS[@]}" -type f | sort > "../$NAME.files" \
  && paste <(tr '\n' '\0' < "../$NAME.files" | xargs -0 git hash-object --no-filters --) "../$NAME.files" | sort -k2) > "$OUT.actual-blobs"
cmp -s "$OUT.expected-blobs" "$OUT.actual-blobs" || { echo "FATAL: bundle source differs from HEAD"; diff "$OUT.expected-blobs" "$OUT.actual-blobs" | head; exit 1; }
echo "API source files byte-identical to HEAD: $(wc -l < "$OUT.actual-blobs")"
rm -f "$OUT.expected-blobs" "$OUT.actual-blobs" "release/$NAME.files"
cp -r "$WEB" "$OUT/mobile/browser"
# Database release + gates + host script (committed bytes), and the real-DB behaviour suites for the drill.
# Read-only host checks (live switches; one driver's inspection evidence) travel with every bundle.
for f in VERIFY.sql PREREQ.sql ORDER.txt release-up.sql release-dryrun.sql release-down.sql RELEASE-MIGRATIONS.sha256 host-db-release.sh; do git -c core.autocrlf=false cat-file -p "HEAD:$REL/$f" > "$OUT/$f"; done
for f in host-live-config.sh live-config.sql trace-driver-inspection.sql; do git -c core.autocrlf=false cat-file -p "HEAD:$TOOLS/$f" > "$OUT/$f"; done
# Develop activation scripts (approved GB values) travel with the bundle; nothing runs them automatically.
ACT=deploy/vaydu-develop-activation
if git cat-file -e "HEAD:$ACT/README.md" 2>/dev/null; then mkdir -p "$OUT/activation"
  for f in $(git ls-tree --name-only HEAD "$ACT/"); do git -c core.autocrlf=false cat-file -p "HEAD:$f" > "$OUT/activation/$(basename "$f")"; done; fi
EXTRA_TESTS=(); if git cat-file -e "HEAD:$REL/TESTS.txt" 2>/dev/null; then mapfile -t EXTRA_TESTS < <(git cat-file -p "HEAD:$REL/TESTS.txt" | grep -v '^#' | grep .); fi
for t in deploy/vaydu-cash-ride-market-pilot/realdb-market-pilot-test.sql deploy/vaydu-cash-ride-market-pilot/realdb-cash-booking-acquisition-test.sql \
         deploy/vaydu-cash-ride-market-pilot/realdb-cash-booking-chain-test.sql deploy/vaydu-cash-ride-market-pilot/realdb-cash-ride-lifecycle-test.sql \
         scripts/migration-merge/realdb-merge-test.sql scripts/driver-metrics/realdb-driver-metrics-test.sql scripts/cancellation-fee/realdb-cancellation-fee-test.sql "${EXTRA_TESTS[@]}"; do
  git -c core.autocrlf=false cat-file -p "HEAD:$t" > "$OUT/tests/$(basename "$t")"; done
echo "$SHA" > "$OUT/SOURCE_SHA"; echo "$WEB_BUILD_SHA" > "$OUT/WEB_BUILD_SHA"
(cd "$OUT" && sha256sum VERIFY.sql PREREQ.sql ORDER.txt SOURCE_SHA release-up.sql release-down.sql release-dryrun.sql host-db-release.sh > SHA256SUMS \
  && find . -type f ! -name SHA256SUMS ! -name ALL_SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > ALL_SHA256SUMS)
(cd release && tar -czf "${NAME}.tar.gz" "$NAME" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256")
echo "Bundle: release/${NAME}.tar.gz"; cat "release/${NAME}.tar.gz.sha256"; echo "SOURCE_SHA: $SHA  WEB_BUILD_SHA: $WEB_BUILD_SHA"
