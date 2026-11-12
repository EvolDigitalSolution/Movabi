# Develop deployment — release 635a285 (top-up fixes + cash-ride code, cash rides OFF)

**Authorised by the user on 2026-11-12** for shared develop only: deploy API/web `635a285` and
apply cash-ride migrations 1–4. **Not authorised here:** enabling any cash-ride market, setting
`VAYDU_CASH_RIDE_BOOKING`, production, or any other market/cohort change.

Run by someone with SSH access to `edsadmin@87.106.64.25` (the agent has none). Stop at the first
result that differs from "Expected". Every step before 3 is read-only toward running services.

| | Value |
|---|---|
| Currently deployed | API `movabi-api:release-f6e8c00-topup`, web `movabi-web:release-f6e8c00-topup-linux` (web verified by asset hash 2026-11-12) |
| Package | `release/vaydu-develop-635a285-topup-linux.tar.gz` |
| SHA-256 | `cbd60346fbc52db7ac99fd56c2f8226c7249185dfa204456cbb8862a7f8e14a6` (re-checked 2026-11-12) |
| Source | `635a285`; later commits on the branch change tests/docs only (no packaged file) |
| New tags | API `movabi-api:release-635a285-topup`, web `movabi-web:release-635a285-topup-linux` |
| Order | 0 upload → 1 predeploy → 2 backup → 3 migrations → 4 API → 5 web → 6 checks |

Why it is safe with cash rides off: every new cash code path (create, dispatch release, completion,
no-show) requires `metadata.cash_collection_mode='full_customer_charge'`, which no earlier release
writes (precheck 1c proves none exist); the booking branch also requires the API flag; the
migrations enable no market and only widen states / add objects.

## 0) Upload (Windows PowerShell, one line)

```
scp "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-635a285-topup-linux.tar.gz" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-635a285-topup-linux.tar.gz.sha256" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\supabase\migrations\20261266000000_driver_cash_credit_market_pilot.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\supabase\migrations\20261266100000_cash_ride_booking_fee_hold.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\supabase\migrations\20261266200000_cash_ride_activation.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\supabase\migrations\20261266300000_cash_ride_completion.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\deploy\vaydu-cash-ride-market-pilot\20261266000000_driver_cash_credit_market_pilot.down.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\deploy\vaydu-cash-ride-market-pilot\20261266100000_cash_ride_booking_fee_hold.down.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\deploy\vaydu-cash-ride-market-pilot\20261266200000_cash_ride_activation.down.sql" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\deploy\vaydu-cash-ride-market-pilot\20261266300000_cash_ride_completion.down.sql" edsadmin@87.106.64.25:~/
```

## 1) Host prechecks (read-only)

```
cd ~
sha256sum -c vaydu-develop-635a285-topup-linux.tar.gz.sha256
sha256sum host-predeploy.sh host-rollback.sh rollout-develop-52097ef.sh
DBQ() { docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -tA'; }
```

Expected: `OK`, then exactly

```
306adf03c8742a3433a7737aabc2ea9dca1247eaffe6b7d7b0aab8a8ad644af2  host-predeploy.sh
0259bd51acdcc09f41be998efce3bdbb982cccbe0faf090182271cd23c24b96e  host-rollback.sh
54de2e6be3bad38ede117414fd6ca5480b110b10541c4c5b4e81c7ed34c6675d  rollout-develop-52097ef.sh
```

(a different hash: the host copy is not the reviewed script — STOP.)

1a) Bundle vs running services:

```
bash host-predeploy.sh vaydu-develop-635a285-topup-linux.tar.gz
PRE=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); echo "$PRE"
cat "$PRE/running-source-sha.txt"; cat "$PRE/previous.env" | grep -E 'API_IMAGE=|WEB_IMAGE='
cat "$PRE/api-changes.txt"; wc -l < "$PRE/web-changes.txt"
```

Expected: `f6e8c00`; `API_IMAGE=movabi-api:release-f6e8c00-topup`, `WEB_IMAGE=movabi-web:release-f6e8c00-topup-linux`;
api-changes = exactly the 13 lines in `release/expected-api-changes-635a285.txt`; web-changes = 91 lines
(`release/expected-web-changes-635a285.txt`). **Keep `$PRE`** — it is the rollback record.

1b) The cash-ride API flag must be absent:

```
grep -rn VAYDU_CASH_RIDE_BOOKING ~/vaydu-develop-overrides/ /srv/movabi/develop/*.yml 2>/dev/null; echo "exit=$?"
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING; echo "exit=$?"
```

Expected: no matches (`exit=1`) and `exit=1`.

1c) No job already uses the new cash mode; cash pilot state:

```
echo "BEGIN READ ONLY;
select count(*) from public.jobs where metadata->>'cash_collection_mode'='full_customer_charge';
select coalesce((select enabled::text from public.driver_cash_credit_config_v1e where key='ride_cash_credit'),'absent');
ROLLBACK;" | DBQ
```

Expected: `0` and `false` or `absent`. Anything else: STOP.

## 2) Database backup (before any change)

```
mkdir -p ~/vaydu-develop-backups; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
B=~/vaydu-develop-backups/develop-before-635a285-$STAMP.dump
docker exec movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop -Fc' > "$B"
sha256sum "$B" | tee "$B.sha256"
docker exec -i movabi-develop-db pg_restore --list < "$B" | grep -c 'TABLE DATA'
echo "$B"
```

Expected: a non-empty dump, a checksum, a TABLE DATA count > 0. Record the path and checksum here
in the release record. (A full isolated restore drill of this archive is a separate roadmap item 9b.)

## 3) Migrations 1–4 (no market is enabled by any of them)

Follow `deploy/vaydu-cash-ride-market-pilot/README.md` exactly, with the `DBQ` above:

1. "Develop runbook" **step 1** (precheck fingerprints) → **step 2** (apply `20261266000000`) → **step 3** (verify; markets count `0`).
2. "Cash-ride booking migrations (2-4)": `FP2` **BEFORE** fingerprints → **Apply** loop → **AFTER** fingerprints.
3. **Do NOT run step 4** (enable GB) and do not add the API flag.

Then confirm nothing is enabled:

```
echo "BEGIN READ ONLY; select count(*) from public.driver_cash_credit_markets_v1e where enabled;
select country_code, public.driver_cash_credit_market_enabled_v1e(country_code,supported_currency) from public.market_availability order by 1; ROLLBACK;" | DBQ
```

Expected: `0`, and `f` for every market.

## 4) API

```
cd ~
export ARCHIVE=vaydu-develop-635a285-topup-linux.tar.gz BUNDLE_DIR=vaydu-develop-635a285-topup-linux EXPECTED_SOURCE_SHA=635a285
API_TAG=release-635a285-topup WEB_TAG=release-f6e8c00-topup-linux bash rollout-develop-52097ef.sh --deploy-api-only --preflight
API_TAG=release-635a285-topup WEB_TAG=release-f6e8c00-topup-linux bash rollout-develop-52097ef.sh --deploy-api-only
```

`WEB_TAG` stays the running web tag during this step. The script validates both checksum lists and
`SOURCE_SHA`, runs the read-only `VERIFY.sql`, builds and recreates **only** the API with the wallet override.

Check:

```
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api
curl -s https://movabi-api-develop.apps.evolsolution.com/health
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING; echo "exit=$?"
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'error|fatal' | head
```

Expected: `movabi-api:release-635a285-topup running`, `{"status":"ok"}`, `exit=1`, no new errors.
Failure → `bash host-rollback.sh "$PRE" api`.

## 5) Web

```
API_TAG=release-635a285-topup WEB_TAG=release-635a285-topup-linux bash rollout-develop-52097ef.sh --deploy-web-only
```

Check: `docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'`
→ `movabi-web:release-635a285-topup-linux Up …`. Then tell the agent: it will hash-compare the live
web assets with the 635a285 bundle over HTTPS. Failure → `bash host-rollback.sh "$PRE" web`.

## 6) After deployment (read-only + UI)

- Run both sections of `DEVELOP-LEDGER-AND-CASH-RIDE-CHECKS.txt` and paste the output (ids and amounts only).
- GB test driver, Driver Hub → Wallet: message says cash rides are not enabled in GB; **Top up** is
  offered. Top up a small amount with a Stripe **test** card: the panel shows "Payment verified",
  closes and resets, and the balance rises by the credit amount only. Reload: no second credit.
  Re-run ledger section 1: that attempt has `credit_events 1`, `ledger_rows 2`.
- Customer booking page: no cash option is offered (flag off).

## Rollback

- App: `bash host-rollback.sh "$PRE" api|web|both` (restores the recorded f6e8c00 images; no schema change).
- DB (only if needed; app rollback first is not required — f6e8c00 ignores the new objects): the
  README rollback sections, newest migration first. With no cash jobs and no enabled market this
  restores the deployed function bodies verbatim (proved locally: schema byte-identical after rollback,
  `bash scripts/cash-ride/run-realdb-tests.sh`).
- Never restore the whole database backup over develop to undo a release.

## Record (fill in)

| Item | Value |
|---|---|
| `$PRE` | |
| Backup path / sha256 | |
| Migration AFTER fingerprints match | |
| API image / time | |
| Web image / time | |
| Ledger check output | |
