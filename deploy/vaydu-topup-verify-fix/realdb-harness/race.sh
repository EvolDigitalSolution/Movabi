#!/bin/bash
# For N fresh attempts: run confirm_wallet_topup_with_total and mark_wallet_topup_failed concurrently
# (as service_role). Invariant: exactly one wins; never credited AND failed; at most one ledger event.
P="psql -h /var/tmp -p 55432 -U postgres -X -q -d vaydu_batch2a_test -At"
D=22222222-2222-4222-8222-222222222222; T=11111111-1111-4111-8111-111111111111
bad=0; credited=0; failed=0
for i in $(seq 1 25); do
  k=race-$(cat /proc/sys/kernel/random/uuid)
  A=$($P -c "set role service_role; select public.initiate_wallet_topup('driver-topup:$D:$k','$T','$D','GB','GBP',1000,'driver_cash_credit','stripe','stripe-platform','$k')" | tail -1)
  $P -c "set role service_role; select public.freeze_wallet_topup_fee('$A','vaydu-driver-card-5pct-wallet-v1'); select public.claim_wallet_topup_submission('$A'); select public.record_wallet_topup_provider_reference('$A','$A');" >/dev/null
  ($P -c "set role service_role; select public.confirm_wallet_topup_with_total('$A','$A','stripe-platform','GBP',1050,'succeeded')" >/dev/null 2>&1 &)
  ($P -c "set role service_role; select public.mark_wallet_topup_failed('$A','race test')" >/dev/null 2>&1 &)
  ($P -c "set role service_role; select public.confirm_wallet_topup_with_total('$A','$A','stripe-platform','GBP',1050,'succeeded')" >/dev/null 2>&1 &)
  sleep 0.6
  r=$($P -c "select a.status||'|'||(select count(*) from wallet_business_events e where e.id=a.credited_event_id)||'|'||(select count(*) from wallet_movements m where m.event_id=a.credited_event_id) from wallet_topup_attempts a where id='$A'")
  case "$r" in "credited|1|2") credited=$((credited+1));; "failed|0|0") failed=$((failed+1));; *) bad=$((bad+1)); echo "VIOLATION $A $r";; esac
done
echo "trials=25 credited_once=$credited failed_no_credit=$failed violations=$bad"
