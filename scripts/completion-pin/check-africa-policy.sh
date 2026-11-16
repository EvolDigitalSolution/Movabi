#!/usr/bin/env bash
# Sourced only by the owned disposable release rehearsal. Never accepts a database URL.
pinroot="$root/deploy/vaydu-completion-pin-africa"
docker exec "$db" mkdir -p /tmp/pin-africa
docker exec -i "$db" sh -c 'cat > /tmp/pin-africa/apply.sql' < "$pinroot/apply.sql"
docker exec -i "$db" sh -c 'cat > /tmp/pin-africa/acceptance-market.sql' < "$root/supabase/migrations/20261270400000_completion_pin_acceptance_market.sql"
q movabi_develop -f /tmp/pin-africa/apply.sql > "$tmp/pin-africa-apply.log" 2>&1 || { tail -30 "$tmp/pin-africa-apply.log"; return 1; }
q movabi_develop -f /tmp/pin-africa/apply.sql > "$tmp/pin-africa-reapply.log" 2>&1 || { tail -30 "$tmp/pin-africa-reapply.log"; return 1; }
q movabi_develop < "$root/deploy/vaydu-develop-release-2/VERIFY.sql" > "$tmp/pin-africa-verify.log" 2>&1 || { tail -20 "$tmp/pin-africa-verify.log"; return 1; }
run_test movabi_develop "$root/scripts/completion-pin/realdb-africa-defaults-test.sql" 'African PIN defaults: acceptance, frozen jobs, explicit countries, tenant/driver isolation'
echo 'PIN_AFRICA_REHEARSAL_OK: audited atomic policy apply twice; existing release fingerprints/guards retained'
