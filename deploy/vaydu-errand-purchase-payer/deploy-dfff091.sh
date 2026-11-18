#!/usr/bin/env bash
# Develop deployment wrapper for vaydu-develop-release-dfff091.tar.gz
#
# Run on the develop host (edsadmin@87.106.64.25).
#
#   bash deploy-dfff091.sh <archive.tar.gz>          full deploy
#   bash deploy-dfff091.sh --plan <archive.tar.gz> <preflight-capture.txt>
#        verify the archive, run the preflight gates + apply-list selection
#        against a captured preflight output, print the list. No docker, no DB,
#        no deployment.
#   bash deploy-dfff091.sh --selftest
#        regression suite for gate/selection logic on synthetic captures.
#   bash deploy-dfff091.sh --rollback <evidence-dir>
#
# Guarantees:
#   - no compose/override file on the host is edited; image pins resolve through
#     an appended candidate overlay only
#   - VAYDU_CASH_RIDE_BOOKING=true and VAYDU_DRIVER_PAYOUT_TRANSFERS=false are
#     asserted before AND after; provider/Vaydu env must be identical
#     post-deploy (compared silently — only variable NAMES are ever reported);
#     no payout gate is enabled
#   - evidence dir is mode 700 with 600 files (full environment credentials)
#   - every failure aborts before the next step
set -euo pipefail
umask 077   # evidence files contain full environment credentials

die(){ echo "DEPLOY FAIL: $*" >&2; exit 1; }
step(){ echo; echo "== $*"; }
need(){ command -v "$1" >/dev/null || die "missing host tool: $1"; }

SRC_SHA="dfff091"
API_TAG="movabi-api:release-dfff091"
WEB_TAG="movabi-web:release-dfff091-linux"

# ---------------------------------------------------------------------------
# Preflight gate + apply-list selection — pure functions over a captured
# preflight output file and an extracted archive root. No docker/DB needed, so
# the same code path is exercised by --selftest, --plan and the deploy run.
# ---------------------------------------------------------------------------

gate_preflight(){ # $1 = preflight capture file; dies on any unsafe state
  local PRE="$1"
  [ -s "$PRE" ] || die "preflight capture missing or empty: $PRE"
  if ! grep -qE '\|missing$|\|DEFINITION-DIFFERS$' "$PRE"; then
    die "preflight shows nothing to apply — is this database already at the release?"
  fi
  if grep -qE '^prereq/baseline\|.*\|missing$' "$PRE"; then
    die "baseline prerequisites missing — not the reviewed develop state; STOP"
  fi
  if grep -qE '^prereq/collection\|.*\|missing$' "$PRE"; then
    die "collection prerequisites missing — no shipped file fixes them; STOP"
  fi
  local pt
  pt="$(awk -F'|' '/^patch-target\/547\|/{print $3}' "$PRE")"
  [ "$pt" = "definition-verified" ] \
    || die "patch-target/547 = '${pt:-missing}' — deployed complete_job_with_pending_payout lacks the reviewed anchor; STOP"
  if grep -qE '\.sql\|recorded-applied\|[1-9]' "$PRE"; then
    die "a recorded-applied migration has missing objects — drift; STOP"
  fi
}

grp_state(){ grep -cE "^$1\|.*\|$2\$" "$3" || true; }
file_recorded(){ grep -qE "^[^|]*$1[^|]*\.sql\|recorded-applied\|" "$2"; }

select_apply_list(){ # $1=preflight capture $2=archive root → files on stdout
  local PRE="$1" R="$2"
  local grp file ver spec mig needs
  local APPLY=()
  for spec in "prereq/547 db/prerequisites/20261254700000_flutterwave_payout_outbox.sql 20261254700000" \
              "prereq/548 db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql 20261254800000"; do
    grp="${spec%% *}"; file="$(echo "$spec" | cut -d' ' -f2)"; ver="${spec##* }"
    if [ "$(grp_state "$grp" missing "$PRE")" -gt 0 ]; then
      if file_recorded "$ver" "$PRE"; then die "drift: $ver recorded-applied but objects missing"; fi
      APPLY+=("$file")
    elif [ "$(grp_state "$grp" 'DEFINITION-DIFFERS' "$PRE")" -gt 0 ]; then
      die "drift: deployed $grp function has a foreign definition; STOP"
    elif grep -qE "^[^|]*$ver[^|]*\.sql\|(not-recorded|unknown)\|0$" "$PRE"; then
      die "drift: $ver objects present but unrecorded; STOP"
    else
      echo "  skip $file (verified present)" >&2
    fi
  done
  while IFS= read -r mig; do
    [ -n "$mig" ] || continue
    grp="${mig:0:9}"; file="db/migrations/$mig.sql"; ver="${mig:0:14}"
    needs=0
    [ "$(grp_state "$grp" missing "$PRE")" -gt 0 ] && needs=1
    [ "$(grp_state "$grp" 'DEFINITION-DIFFERS' "$PRE")" -gt 0 ] && needs=1
    if [ "$needs" = 1 ]; then
      if file_recorded "$ver" "$PRE"; then die "drift: $ver recorded-applied but needs apply"; fi
      APPLY+=("$file")
    else
      if grep -qE "^[^|]*$ver[^|]*\.sql\|not-recorded\|0$" "$PRE"; then
        die "drift: $ver objects present/verified but unrecorded"
      fi
      echo "  skip $file (verified present)" >&2
    fi
  done < <(grep -oE '^2026127[0-9]{7}_[a-z_]+' "$R/db/migrations/APPLY-ORDER.txt")
  [ "${#APPLY[@]}" -gt 0 ] || die "nothing eligible to apply"
  printf '%s\n' "${APPLY[@]}"
}

verify_archive(){ # $1=tar.gz → echoes extracted root path
  local ARCH="$1" E R
  [ -f "$ARCH" ] || die "archive not found: $ARCH"
  [ -f "$ARCH.sha256" ] || die "checksum file missing: $ARCH.sha256"
  (cd "$(dirname "$ARCH")" && sha256sum -c --quiet "$(basename "$ARCH").sha256") \
    || die "archive sha256 mismatch"
  E=$(mktemp -d /tmp/vaydu-verify.XXXXXX)
  tar -xzf "$ARCH" -C "$E"
  R="$(dirname "$(find "$E" -maxdepth 3 -name CHECKSUMS.sha256 | head -1)")"
  [ -n "$R" ] && [ -f "$R/CHECKSUMS.sha256" ] || die "archive has no CHECKSUMS.sha256"
  (cd "$R" && sha256sum -c --quiet CHECKSUMS.sha256) || die "inner CHECKSUMS.sha256 mismatch"
  for f in db/preflight-schema-check.sql runbook/rehearse-restore.sh runbook/RUNBOOK.md \
           db/prerequisites/20261254700000_flutterwave_payout_outbox.sql \
           db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql \
           db/migrations/APPLY-ORDER.txt \
           db/tests/realdb-errand-purchase-payer-test.sql \
           db/tests/realdb-customer-funding-chain-test.sql \
           api/server/Dockerfile api/package.json web/mobile/index.html; do
    [ -f "$R/$f" ] || die "archive layout unexpected — missing $f"
  done
  echo "$R"
}

selftest(){
  local T; T=$(mktemp -d /tmp/dfff091-selftest.XXXXXX)
  local ROOT="$1"
  # Synthetic capture matching shipped preflight row formats: all 9 groups need apply.
  cat > "$T/need9.txt" <<'EOF'
prereq/baseline|function:public.complete_job_with_pending_payout|present
prereq/baseline|table:public.driver_earnings|present
prereq/baseline|table:public.driver_payment_accounts|present
prereq/baseline|table:public.driver_payout_markets|present
prereq/baseline|table:public.job_payout_queue|present
prereq/baseline|table:public.jobs|present
prereq/baseline|table:public.profiles|present
prereq/baseline|table:public.refund_operations|present
prereq/baseline|table:public.wallet_movements|present
prereq/collection|column:public.wallet_topup_attempts.provider_account_id|present
prereq/collection|function:public.freeze_wallet_topup_fee|present
prereq/collection|function:public.initiate_wallet_topup|present
prereq/collection|table:public.market_payment_routes|present
prereq/collection|table:public.wallet_topup_attempts|present
patch-target/547|complete_job_with_pending_payout|definition-verified
prereq/547|column:public.driver_earnings.payout_provider|missing
prereq/547|column:public.jobs.payout_provider|missing
prereq/547|function:public.claim_flutterwave_job_submission|missing
prereq/547|table:public.flutterwave_job_submissions|missing
prereq/548|function:public.claim_driver_collection_subaccount|missing
prereq/548|function:public.guard_job_transfer_method|missing
prereq/548|table:public.driver_collection_markets|missing
prereq/548|table:public.driver_collection_subaccounts|missing
prereq/548|table:public.job_settlement_methods|missing
202612705|function:public.claim_queued_job_payout|present
202612705|function:public.finish_queued_job_payout|present
202612705|table:public.errand_purchase_payments|missing
202612706|function:public.bridge_customer_wallet_topup|missing
202612706|function:public.confirm_wallet_topup_with_total|present
202612706|function:public.pay_job_from_wallet|present
202612707|function:public.claim_driver_withdrawal|missing
202612707|function:public.claim_withdrawal_submission|missing
202612707|function:public.driver_earnings_wallet_balance|missing
202612707|function:public.mark_driver_withdrawal_retry|missing
202612707|function:public.request_driver_withdrawal|missing
202612707|function:public.reverse_driver_withdrawal|missing
202612707|table:public.driver_payout_markets|present
202612707|table:public.driver_withdrawal_submissions|missing
202612707|table:public.driver_withdrawals|missing
202612708|function:public.resolve_driver_settlement_method|missing
202612708|function:public.set_driver_settlement_preference|missing
202612708|table:public.driver_payout_preferences|missing
202612709|function:public.finish_driver_withdrawal|missing
202612709|function:public.payout_withdrawal_provider_supported|missing
202612710|column:public.market_payment_routes.provider_account_id|missing
202612711|function:public.finish_driver_withdrawal|missing
202612705|complete_job_with_pending_payout|DEFINITION-DIFFERS
202612705|finish_queued_job_payout|DEFINITION-DIFFERS
202612705|finish_flutterwave_job_payout|function-absent
202612707|guard_job_transfer_method|function-absent
202612708|guard_job_transfer_method|function-absent
202612709|payout_withdrawal_provider_supported|function-absent
202612710|freeze_wallet_topup_fee|definition-verified
202612711|finish_driver_withdrawal|function-absent
prereq/547|claim_flutterwave_job_submission|function-absent
20261254700000_flutterwave_payout_outbox.sql|unknown|4
20261254800000_flutterwave_collection_subaccounts.sql|unknown|5
20261270500000_errand_purchase_payer.sql|unknown|1
20261270600000_customer_wallet_booking_bridge.sql|unknown|1
20261270700000_driver_wallet_settlement.sql|unknown|8
20261270800000_driver_settlement_policy.sql|unknown|3
20261270900000_kora_payout_adapter.sql|unknown|2
20261271000000_customer_collection_account_binding.sql|unknown|1
20261271100000_kora_settle_reference.sql|unknown|1
EOF
  local out rc
  step "selftest 1 — missing prerequisites select the nine reviewed files"
  out="$(select_apply_list "$T/need9.txt" "$ROOT" 2>/dev/null)" \
    || die "selftest 1: selection failed on the missing-state capture"
  printf '%s\n' "$out" > "$T/got.txt"
  cat > "$T/want.txt" <<'EOF'
db/prerequisites/20261254700000_flutterwave_payout_outbox.sql
db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql
db/migrations/20261270500000_errand_purchase_payer.sql
db/migrations/20261270600000_customer_wallet_booking_bridge.sql
db/migrations/20261270700000_driver_wallet_settlement.sql
db/migrations/20261270800000_driver_settlement_policy.sql
db/migrations/20261270900000_kora_payout_adapter.sql
db/migrations/20261271000000_customer_collection_account_binding.sql
db/migrations/20261271100000_kora_settle_reference.sql
EOF
  diff -u "$T/want.txt" "$T/got.txt" || die "selftest 1: apply list is not the expected nine files"
  gate_preflight "$T/need9.txt" || die "selftest 1: gate rejected a valid capture"
  echo "  nine files selected, gate passed"

  expect_stop(){ # $1=label $2=file — gate or select must reject (subshell so die is catchable)
    local rc=0
    ( gate_preflight "$2" && select_apply_list "$2" "$ROOT" ) >/dev/null 2>&1 || rc=1
    [ "$rc" = 1 ] || die "selftest: $1 was NOT stopped"
    echo "  stopped as required: $1"
  }
  step "selftest 2 — unsafe states stop before apply"
  sed 's/^prereq\/baseline|table:public.jobs|present$/prereq\/baseline|table:public.jobs|missing/' \
    "$T/need9.txt" > "$T/baseline-missing.txt"
  expect_stop "baseline prerequisite missing" "$T/baseline-missing.txt"
  sed 's/^prereq\/collection|table:public.market_payment_routes|present$/prereq\/collection|table:public.market_payment_routes|missing/' \
    "$T/need9.txt" > "$T/collection-missing.txt"
  expect_stop "collection prerequisite missing" "$T/collection-missing.txt"
  sed 's/|definition-verified$/|definition-differs/' "$T/need9.txt" > "$T/patch-unsafe.txt"
  expect_stop "patch-target foreign definition" "$T/patch-unsafe.txt"
  sed 's/^20261270500000_errand_purchase_payer.sql|unknown|1$/20261270500000_errand_purchase_payer.sql|recorded-applied|1/' \
    "$T/need9.txt" > "$T/recorded-missing.txt"
  expect_stop "recorded-applied with missing objects" "$T/recorded-missing.txt"
  # 547 group fully present/verified but unrecorded → drift stop
  grep -vE '^prereq/547\|' "$T/need9.txt" \
    | sed 's/^20261254700000_flutterwave_payout_outbox.sql|unknown|4$/20261254700000_flutterwave_payout_outbox.sql|not-recorded|0/' \
    > "$T/unrecorded-present.txt"
  expect_stop "unrecorded but verified present" "$T/unrecorded-present.txt"
  rm -rf "$T"
  echo "SELFTEST PASSED: 1 list + 5 stops"
}

# ---------------------------------------------------------------------------
# Modes that do not need docker
# ---------------------------------------------------------------------------

case "${1:-}" in
  --selftest)
    if [ -n "${2:-}" ]; then
      need sha256sum; need tar
      R="$(verify_archive "$2")"
    else
      mkdir -p /tmp/dfff091-fake/db/migrations
      printf '%s\n' \
        20261270500000_errand_purchase_payer 20261270600000_customer_wallet_booking_bridge \
        20261270700000_driver_wallet_settlement 20261270800000_driver_settlement_policy \
        20261270900000_kora_payout_adapter 20261271000000_customer_collection_account_binding \
        20261271100000_kora_settle_reference > /tmp/dfff091-fake/db/migrations/APPLY-ORDER.txt
      R="/tmp/dfff091-fake"
    fi
    selftest "$R"; exit 0 ;;
  --plan)
    [ $# -eq 3 ] || die "usage: $0 --plan <archive.tar.gz> <preflight-capture.txt>"
    need sha256sum; need tar
    R="$(verify_archive "$2")"
    gate_preflight "$3"
    select_apply_list "$3" "$R" > /tmp/dfff091-plan-list.txt
    echo "PLAN: apply $(wc -l < /tmp/dfff091-plan-list.txt) files:"
    cat /tmp/dfff091-plan-list.txt
    echo "plan only — no database changes made, nothing deployed"
    exit 0 ;;
  --rollback)
    [ -d "${2:-}" ] || die "usage: $0 --rollback <evidence-dir>"
    [ -f "$2/rollback.sh" ] || die "no rollback.sh in $2"
    exec bash "$2/rollback.sh" ;;
esac

# ---------------------------------------------------------------------------
# Deploy mode — needs docker on the develop host
# ---------------------------------------------------------------------------

[ "${MSYSTEM:-}" ] && die "run on the develop host, not in a Windows shell"
need docker; need sha256sum; need tar; need curl
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"
docker info >/dev/null 2>&1 || die "docker daemon unreachable"

RESUME=0
if [ "${1:-}" = "--resume" ]; then
  [ -d "${2:-}" ] || die "usage: $0 --resume <evidence-dir>"
  E="$2"; RESUME=1
fi

if [ "$RESUME" = 0 ]; then
  [ $# -eq 1 ] || die "usage: $0 <archive.tar.gz> | --resume <evidence-dir> | --plan <archive> <capture> | --selftest [archive] | --rollback <dir>"
  ARCH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  step "0 archive integrity"
  (cd "$(dirname "$ARCH")" && sha256sum -c --quiet "$(basename "$ARCH").sha256") || die "archive sha256 mismatch"
  E=$(mktemp -d /home/edsadmin/vaydu-release-dfff091.XXXXXX)
  chmod 700 "$E"
  echo "evidence: $E"
  tar -xzf "$ARCH" -C "$E"
else
  step "0 resume — reuse existing evidence and backup"
  R="$E/vaydu-develop-release-dfff091"
fi
[ -d "$R" ] || R="$(dirname "$(find "$E" -maxdepth 3 -name CHECKSUMS.sha256 | head -1)")"
(cd "$R" && sha256sum -c --quiet CHECKSUMS.sha256) || die "inner CHECKSUMS.sha256 mismatch"

# Corrected tooling (this bundle's rehearse-restore.sh carries the captured-
# roles preparation the host backup requires) replaces the archived copy
# before use; both are checksummed so provenance stays auditable.
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$TOOLS_DIR/rehearse-restore.sh" ] || die "corrected rehearse-restore.sh missing next to this wrapper"
[ -f "$TOOLS_DIR/capture-roles.sql" ]   || die "capture-roles.sql missing next to this wrapper"
for s in realdb-errand-purchase-payer-test.sql realdb-customer-funding-chain-test.sql; do
  [ -f "$TOOLS_DIR/$s" ] || die "corrected behaviour suite missing next to this wrapper: $s"
done
if [ -f "$TOOLS_DIR/CHECKSUMS.sha256" ]; then
  (cd "$TOOLS_DIR" && sha256sum -c --quiet CHECKSUMS.sha256) || die "tooling checksum mismatch"
fi
install -m 755 "$TOOLS_DIR/rehearse-restore.sh" "$R/runbook/rehearse-restore.sh"
# Fixture-isolation corrected suites (adopt-or-insert + post-rollback
# preservation proof) replace the archived copies before the rehearsal runs.
for s in realdb-errand-purchase-payer-test.sql realdb-customer-funding-chain-test.sql; do
  install -m 644 "$TOOLS_DIR/$s" "$R/db/tests/$s"
done

DBQ() { docker exec -i movabi-develop-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off'; }
DBQT() { docker exec -i movabi-develop-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -qAt -F"|"'; }

step "1 recovery state (images, compose, env)"
docker ps --format '{{.Names}}' | grep -qx movabi-develop-api || die "movabi-develop-api not running"
docker ps --format '{{.Names}}' | grep -qx movabi-develop-db  || die "movabi-develop-db not running"
for svc in api web; do
  c="movabi-develop-$svc"
  if [ "$svc" = web ]; then
    c=$(docker ps --filter label=com.docker.compose.service=web \
      --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}}' | head -1)
  fi
  [ -n "$c" ] || die "web container not found"
  echo "$c" > "$E/$svc-container.txt"
  docker inspect -f '{{.Image}}'       "$c" > "$E/$svc-image-id.txt"
  docker inspect -f '{{.Config.Image}}' "$c" > "$E/$svc-image-tag.txt"
done
echo "current api: $(cat "$E/api-image-tag.txt") ($(cut -c1-19 "$E/api-image-id.txt"))"
echo "current web: $(cat "$E/web-image-tag.txt") ($(cut -c1-19 "$E/web-image-id.txt"))"
docker exec "$(cat "$E/api-container.txt")" sh -c 'cat /app/SOURCE_SHA 2>/dev/null || echo unknown' \
  > "$E/api-before-source.txt"
docker exec "$(cat "$E/api-container.txt")" printenv | sort > "$E/api-env-before.txt"
grep -qx 'VAYDU_CASH_RIDE_BOOKING=true' "$E/api-env-before.txt" \
  || die "VAYDU_CASH_RIDE_BOOKING is not 'true' on the running API — refusing to proceed"
grep -qx 'VAYDU_DRIVER_PAYOUT_TRANSFERS=false' "$E/api-env-before.txt" \
  || die "VAYDU_DRIVER_PAYOUT_TRANSFERS is not 'false' on the running API — refusing to proceed"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [ -f "$E/api-recovery-tag.txt" ] && [ -f "$E/web-recovery-tag.txt" ]; then
  echo "reusing recovery tags: $(cat "$E/api-recovery-tag.txt") / $(cat "$E/web-recovery-tag.txt")"
else
for svc in api web; do
  tag="movabi-$svc:recovery-dfff091-$STAMP"
  if docker image inspect "$tag" >/dev/null 2>&1; then die "recovery tag already exists: $tag"; fi
  docker image tag "$(cat "$E/$svc-image-id.txt")" "$tag"
  echo "$tag" > "$E/$svc-recovery-tag.txt"
done
fi

docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-files.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-workdir.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-project.txt"
[ "$(cat "$E/compose-project.txt")" = "movabi-develop" ] || die "unexpected compose project"
IFS=',' read -r -a CFILES < "$E/compose-files.txt"
CARGS=(--project-name movabi-develop --project-directory "$(cat "$E/compose-workdir.txt")")
for f in "${CFILES[@]}"; do
  [ -f "$f" ] || die "compose file recorded by container is missing: $f"
  CARGS+=(-f "$f")
done
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' \
  "$(cat "$E/api-image-id.txt")" "$(cat "$E/web-image-id.txt")" > "$E/recovery.compose.yml"
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' "$API_TAG" "$WEB_TAG" \
  > "$E/candidate.compose.yml"

cat > "$E/rollback.sh" <<RB
#!/usr/bin/env bash
set -euo pipefail
cd "$(cat "$E/compose-workdir.txt")"
docker compose $(printf '%q ' "${CARGS[@]}")-f $E/recovery.compose.yml up -d --no-deps --no-build api web
docker inspect -f '{{.Config.Image}}' movabi-develop-api
curl -fsS https://movabi-api-develop.apps.evolsolution.com/health
RB
chmod 700 "$E/rollback.sh"
echo "recovery tags: $(cat "$E/api-recovery-tag.txt") / $(cat "$E/web-recovery-tag.txt")"
echo "rollback:      $E/rollback.sh (or: bash $0 --rollback $E)"

step "1b capture host roles (read-only, no passwords)"
DBQT < "$TOOLS_DIR/capture-roles.sql" > "$E/roles.sql" || die "role capture failed"
[ -s "$E/roles.sql" ] || die "role capture produced no statements"
echo "captured $(grep -c 'role:' "$E/roles.sql") role records and $(grep -c 'grant:' "$E/roles.sql") grants"

step "2 backup movabi_develop (full, custom format)"
B="$(ls -t "$E"/develop-before-dfff091-*.dump 2>/dev/null | head -1)"
if [ -n "${B:-}" ] && [ -s "$B" ]; then
  echo "reusing existing backup: $B"
else
  B="$E/develop-before-dfff091-$STAMP.dump"
  docker exec movabi-develop-db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop -Fc' > "$B"
  [ -s "$B" ] || die "backup is empty"
  sha256sum "$B" | tee "$B.sha256"
fi
# pg_restore cannot seek a custom-format TOC on stdin — stage the file into
# the container and capture listing output + exit status separately.
docker exec movabi-develop-db rm -f /tmp/dfff091-list.dump || true
docker cp "$B" movabi-develop-db:/tmp/dfff091-list.dump || die "docker cp of backup failed"
docker exec movabi-develop-db pg_restore --list /tmp/dfff091-list.dump \
  > "$E/pg-restore-list.txt" 2>"$E/pg-restore-list.err" \
  || { cat "$E/pg-restore-list.err"; die "pg_restore --list failed on the backup"; }
entries="$(grep -c 'TABLE DATA' "$E/pg-restore-list.txt" || true)"
docker exec movabi-develop-db rm -f /tmp/dfff091-list.dump || true
[ "${entries:-0}" -gt 0 ] || die "backup lists no TABLE DATA entries"
echo "backup verified: $B ($entries TABLE DATA entries)"

step "3 corrected restore rehearsal against that backup"
if ! (cd "$R" && ROLES_SQL="$E/roles.sql" bash runbook/rehearse-restore.sh "$B" 2>&1 | tee "$E/rehearsal.log"); then
  die "rehearsal failed — see $E/rehearsal.log"
fi
grep -q "RESTORE REHEARSAL PASSED" "$E/rehearsal.log" \
  || die "rehearsal did not report RESTORE REHEARSAL PASSED"

step "4 preflight + reviewed chain via stdin redirect"
PRE="$E/preflight.txt"
DBQT < "$R/db/preflight-schema-check.sql" > "$PRE" || die "preflight failed"
cat "$PRE"
gate_preflight "$PRE"
select_apply_list "$PRE" "$R" > "$E/applied-migrations.txt"
mapfile -t APPLY < "$E/applied-migrations.txt"
echo "apply list: ${APPLY[*]}"
for f in "${APPLY[@]}"; do
  echo "-- apply $f"
  DBQ < "$R/$f" > "$E/apply-$(basename "$f").log" || die "apply failed: $f (log in evidence dir)"
done
DBQT < "$R/db/preflight-schema-check.sql" > "$E/preflight-after.txt" || die "post-preflight failed"
cat "$E/preflight-after.txt"
if grep -qE '\|missing$|\|DEFINITION-DIFFERS$' "$E/preflight-after.txt"; then
  die "post-apply preflight still reports missing/different objects"
fi

step "5 build API + web images (candidate tags, no overwrite)"
for img in "$API_TAG" "$WEB_TAG"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    die "image tag already exists: $img — refusing to overwrite"
  fi
done
printf '%s\n' "$SRC_SHA" > "$R/api/SOURCE_SHA"
docker build -t "$API_TAG" -f "$R/api/server/Dockerfile" "$R/api" 2>&1 | tee "$E/api-build.log"
WEB_BASE="$(cat "$E/web-image-id.txt")"
printf 'FROM %s\nRUN rm -rf /usr/share/nginx/html/*\nCOPY web/mobile/ /usr/share/nginx/html/\n' \
  "$WEB_BASE" > "$E/Dockerfile.web"
docker build -t "$WEB_TAG" -f "$E/Dockerfile.web" "$R" 2>&1 | tee "$E/web-build.log"
(cd "$R/web/mobile" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
  > "$E/web-expected.sha256"

step "6 deploy via candidate overlay (existing compose files untouched)"
docker compose "${CARGS[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build api
docker compose "${CARGS[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build web

step "7 verify"
img_api="$(docker inspect -f '{{.Config.Image}}' movabi-develop-api)"
[ "$img_api" = "$API_TAG" ] || die "api is not running $API_TAG (got $img_api) — rollback: $E/rollback.sh"
webc="$(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}}' | head -1)"
[ "$(docker inspect -f '{{.Config.Image}}' "$webc")" = "$WEB_TAG" ] \
  || die "web is not running $WEB_TAG — rollback: $E/rollback.sh"
src="$(docker exec movabi-develop-api cat /app/SOURCE_SHA)"
[ "$src" = "$SRC_SHA" ] || die "api SOURCE_SHA '$src' != $SRC_SHA"
docker exec movabi-develop-api printenv | sort > "$E/api-env-after.txt"
grep -E '^(VAYDU|STRIPE|KORA|FLUTTERWAVE|PAYSTACK|SUPABASE)' "$E/api-env-before.txt" | sort > "$E/api-env-before.provider"
grep -E '^(VAYDU|STRIPE|KORA|FLUTTERWAVE|PAYSTACK|SUPABASE)' "$E/api-env-after.txt"  | sort > "$E/api-env-after.provider"
if ! diff -q "$E/api-env-before.provider" "$E/api-env-after.provider" >/dev/null; then
  before_names="$(sed 's/=.*//' "$E/api-env-before.provider" | sort -u)"
  after_names="$(sed 's/=.*//' "$E/api-env-after.provider" | sort -u)"
  changed="$(comm -3 <(echo "$before_names") <(echo "$after_names") | tr '\n' ' ')"
  same_names="$(comm -12 <(echo "$before_names") <(echo "$after_names"))"
  for n in $same_names; do
    if [ "$(grep -c "^$n=" "$E/api-env-before.provider")" != "$(grep -c "^$n=" "$E/api-env-after.provider")" ] \
       || ! cmp -s <(grep "^$n=" "$E/api-env-before.provider") <(grep "^$n=" "$E/api-env-after.provider"); then
      changed="$changed $n(value-changed)"
    fi
  done
  die "provider/Vaydu env changed by deploy (names only): $changed — rollback: $E/rollback.sh"
fi
grep -qx "VAYDU_CASH_RIDE_BOOKING=true" "$E/api-env-after.txt" || die "cash flag lost"
grep -qx "VAYDU_DRIVER_PAYOUT_TRANSFERS=false" "$E/api-env-after.txt" || die "payout-transfers gate changed"

curl -fsS --retry 15 --retry-connrefused --retry-delay 2 \
  https://movabi-api-develop.apps.evolsolution.com/health | tee "$E/health.json" \
  || die "health check failed — rollback: $E/rollback.sh"
curl -fsS https://movabi-api-develop.apps.evolsolution.com/api/app/version \
  | tee "$E/app-version.json" >/dev/null || die "app/version failed"
docker exec -i -w /usr/share/nginx/html "$webc" sha256sum -c --quiet < "$E/web-expected.sha256" \
  || die "served web assets do not match the packaged bundle — rollback: $E/rollback.sh"
pref="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  https://movabi-api-develop.apps.evolsolution.com/api/customer-wallet/topup-readiness \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,content-type')"
[ "$pref" = "204" ] || die "localhost:3000 CORS preflight returned $pref"
ao="$(curl -s -X OPTIONS https://movabi-api-develop.apps.evolsolution.com/api/customer-wallet/topup-readiness \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: GET' \
  -D - -o /dev/null | tr -d '\r' | grep -i '^access-control-allow-origin:')"
echo "$ao" | grep -qi "http://localhost:3000" || die "allow-origin header missing for localhost:3000"
if docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'fatal|unhandled'; then
  die "fatal errors in api log — inspect $E and consider rollback"
fi

echo
echo "DEPLOY OK: api=$API_TAG web=$WEB_TAG source=$SRC_SHA"
echo "migrations applied: $(wc -l < "$E/applied-migrations.txt") (list in evidence dir)"
echo "evidence: $E    rollback: bash $0 --rollback $E"
echo "remaining: real-browser verification from http://localhost:3000 is the user's manual step"
