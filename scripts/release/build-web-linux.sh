#!/usr/bin/env bash
# Build the develop web (ng build mobile --configuration develop) on Linux, as the running develop web
# was built: node:22-alpine, clean npm ci, from the exact committed bytes of HEAD (git archive with
# autocrlf off). Output: release/linux-build-<sha>/out/browser + docker.log. Never deploys anything.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(git rev-parse --show-toplevel)"
SHA=$(git rev-parse --short=7 HEAD)
OUT="release/linux-build-$SHA"; rm -rf "$OUT"; mkdir -p "$OUT/src"
git -c core.autocrlf=false -c core.eol=lf archive --format=tar HEAD | tar -x -C "$OUT/src"
docker run --rm -v "$(cd "$OUT" && pwd -W 2>/dev/null || pwd)":/work -w /work/src node:22-alpine sh -c '
  echo "node $(node -v) npm $(npm -v)"
  npm ci --no-audit --no-fund >/work/npm-ci.log 2>&1; echo "npm ci exit $?"
  npx ng build mobile --configuration develop >/work/ng-build.log 2>&1; rc=$?; echo "build exit $rc"
  grep -E "Application bundle generation|WARNING|ERROR" /work/ng-build.log | head -5
  [ $rc = 0 ] && mkdir -p /work/out && cp -r dist/mobile/browser /work/out/browser
  exit $rc' 2>&1 | tee "$OUT/docker.log"
rm -rf "$OUT/src"
[ -f "$OUT/out/browser/index.html" ] && echo "WEB_BUILD_OK $OUT/out/browser (source $SHA)"
