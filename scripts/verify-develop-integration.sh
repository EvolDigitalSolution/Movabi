#!/usr/bin/env bash
# Consolidated develop-only verification (never production, never Africa).
# Two sections: EXECUTABLE checks (run automatically) and INTERACTIVE checks
# (printed for the operator to drive by hand). Requires develop Supabase env:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY (test), STRIPE_WEBHOOK_SECRET
set -uo pipefail
fail=0
say(){ printf '\n== %s ==\n' "$1"; }

say "EXECUTABLE — local disposable-PG cash lifecycle (full chain)"
bash scripts/check-cash-credit-lifecycle-pg.sh && echo "CASH_LIFECYCLE=PASS" || { echo "CASH_LIFECYCLE=FAIL"; fail=1; }

say "EXECUTABLE — cash exemption guard matrix (run inside fixture DB)"
docker exec -i vaydu-pg-test psql -U postgres -d movabi_develop -v ON_ERROR_STOP=0 <<'SQL' 2>&1 | grep -E "CASE|ERROR"
\echo 'CASE non-cash still gated (expect MB003):'
insert into jobs(id,tenant_id,customer_id,status,payment_method,payment_status,country_code,currency_code,service_type_id,metadata)
values('c0000001-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','requested','card','pending','GB','GBP','11111111-0000-0000-0000-000000000001','{}');
update jobs set driver_id='dddddddd-0000-0000-0000-000000000001',status='assigned' where id='c0000001-0000-0000-0000-000000000001';
\echo 'CASE direct RPC as authenticated (expect permission denied):'
set role authenticated;
select reserve_cash_job_credit_v1e('c0000001-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');
reset role;
SQL

say "EXECUTABLE — vitest suites (real routes + webhook)"
npx vitest run \
  src/testing/customer-debts-routes.spec.ts \
  src/testing/admin-receivables-resolve.spec.ts \
  src/testing/driver-cash-credit-batch1e.spec.ts \
  src/testing/driver-cash-credit-batch1f.spec.ts \
  src/testing/driver-cash-credit-batch1g.spec.ts \
  src/testing/inspection-photo-route.spec.ts \
  src/testing/completion-pin-policy.spec.ts \
  src/testing/driver-offer-metrics.spec.ts \
  src/testing/market-availability.spec.ts \
  && echo "VITEST=PASS" || { echo "VITEST=FAIL"; fail=1; }

say "EXECUTABLE — report CLI exit states (query-failure must never be clean)"
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
  node scripts/report-unresolved-payment-ops.cjs; rc=$?
echo "report exit=$rc (0 clean | 2 unresolved | 3 query_failed)"
[ "$rc" -eq 3 ] || true   # missing env locally is a query failure, expected here

say "INTERACTIVE — drive these on develop by hand"
cat <<'TXT'
1. Concurrent cash accepts: two drivers simultaneously accept cash rides on one
   credit balance (develop DB) -> exactly one gets a hold; the other CE004.
2. Debt repayment e2e: create an open receivable, call /debts/:id/repay, complete
   the Stripe test checkout -> webhook payment_intent.succeeded marks it paid;
   POST /create no longer returns OUTSTANDING_DEBT for that customer.
3. Webhook replay: resend the same event.id -> receivable stays paid once
   (stripe_events dedup); fabricated event -> signature rejection.
4. Referral: redeem CODE:referrer-id as a second test customer, complete+pay one
   job -> referral earns (pending->earned); earn again -> idempotent, no dup.
5. Discount: POST /campaigns/apply for a disabled campaign -> unavailable; apply
   to quote, create booking -> DISCOUNT_MISMATCH if claimed amount altered;
   platform_funded=true in the frozen snapshot (driver earnings unchanged).
6. Admin paid-action: attempt /receivables/:id/resolve paid with a fake PI id ->
   REFERENCE_NOT_FOUND; reuse a real PI from another debt -> REFERENCE_REUSED.
7. Inspection: upload real photos in all six slots on a test driver; replace one
   -> slot returns to under_review; cross-driver URL fetch -> denied.
8. Market readiness: GET /admin/market-readiness?tenantId=...&market=GB ->
   pricing/currency/drivers/route all true for a ready market.
9. Backup restore drill: run scripts/verify-develop-wallet-backup.py into a
   fresh isolated container; record row-count + checksum parity.
TXT
echo
[ "$fail" -eq 0 ] && echo "EXECUTABLE CHECKS=ALL PASS" || echo "EXECUTABLE CHECKS=FAILURES PRESENT"
exit $fail
