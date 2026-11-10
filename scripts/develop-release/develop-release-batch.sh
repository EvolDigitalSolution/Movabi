#!/usr/bin/env bash
# ==============================================================================
# VAYDU v2.3 DEVELOP RELEASE — OPERATOR SCRIPT
# Run ON the develop host (SSH). Modes:
#   diagnose | resolve | provision <tenant> | verify-stripe | account-check
#   configure-plan | configure | admin-build <repo-dir> | admin-cert | deploy-plan
#
# Optional validation-only env: TEST_DRIVER TEST_CUSTOMER TEST_STRIPE_ACCT
# PINNED: movabi-develop-db/movabi_develop, movabi-develop-api, movabi-develop-web,
#         movabi-develop-admin. Production is never inspected or modified.
# Credentials never leave their containers; only allowlisted status printed.
# ==============================================================================
set -u
MODE="${1:-diagnose}"

DB_C="movabi-develop-db";   DBNAME="movabi_develop"
API_C="movabi-develop-api"; API_URL="https://movabi-api-develop.apps.evolsolution.com"
WEB_C="movabi-develop-web"; APP_URL="https://movabi-develop.apps.evolsolution.com"
ADM_C="movabi-develop-admin";ADM_URL="https://movabi-admin-develop.apps.evolsolution.com"
ADM_HOST="${ADM_URL#https://}"

die(){ echo "REFUSING: $*" >&2; exit 2; }
case "$PWD" in */srv/movabi/current*) die "inside production checkout";; esac

require_container(){
  local want="$1" got
  got=$(docker inspect -f '{{.Name}}' "$want" 2>/dev/null | sed 's|^/||') || die "container $want not found"
  [ "$got" = "$want" ] || die "container identity mismatch: wanted $want got $got"
  docker inspect -f '{{.State.Running}}' "$want" | grep -q true || die "container $want is not running"
}
require_container "$DB_C"; require_container "$API_C"; require_container "$WEB_C"; require_container "$ADM_C"

sql(){ docker exec "$DB_C" psql -U postgres -d "$DBNAME" -X -v ON_ERROR_STOP=1 -qAt -c "$1" || die "SQL failed"; }
sql "SELECT current_database()" | grep -qx "$DBNAME" || die "database identity mismatch inside $DB_C"

resolve_ids(){
  sql "SELECT 'drivers_scope_bound', count(*) FROM public.profiles p WHERE p.role='driver'
        AND EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes s WHERE s.enabled AND s.driver_id=p.id)"
  sql "SELECT 'drivers_enrolled', count(*) FROM public.profiles p WHERE p.role='driver'
        AND EXISTS(SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.enabled AND e.driver_id=p.id)"
  sql "SELECT 'drivers_email_marked', count(*) FROM public.profiles p WHERE p.role='driver'
        AND (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic|example|\\.test$)'"
  sql "SELECT 'customers_email_marked', count(*) FROM public.profiles p WHERE p.role='customer'
        AND (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic|example|\\.test$)'"
  echo "-- designated candidates (id + email marker only)"
  sql "SELECT p.role, p.id::text, p.tenant_id::text,
              regexp_replace(u.email,'^(.{2}).*(@.*)$','\\1***\\2')
       FROM public.profiles p JOIN auth.users u ON u.id=p.id
       WHERE (u.email ~* '(test|synthetic|example|\\.test$)')
          OR EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes s WHERE s.enabled AND s.driver_id=p.id)
          OR EXISTS(SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.enabled AND e.driver_id=p.id)
       ORDER BY p.role,p.id"
}

pick_driver(){
  if [ -n "${TEST_DRIVER:-}" ]; then
    sql "SELECT 1 FROM public.profiles WHERE id='$TEST_DRIVER' AND role='driver'" | grep -q 1 \
      || die "TEST_DRIVER=$TEST_DRIVER is not a driver profile"
    echo "$TEST_DRIVER"; return
  fi
  local n id
  n=$(sql "SELECT count(*) FROM public.profiles p WHERE p.role='driver'
    AND (EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes s WHERE s.enabled AND s.driver_id=p.id)
      OR EXISTS(SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.enabled AND e.driver_id=p.id)
      OR (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic)')")
  id=$(sql "SELECT p.id::text FROM public.profiles p WHERE p.role='driver'
    AND (EXISTS(SELECT 1 FROM public.driver_card_topup_sandbox_scopes s WHERE s.enabled AND s.driver_id=p.id)
      OR EXISTS(SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.enabled AND e.driver_id=p.id)
      OR (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic)')
    ORDER BY p.id LIMIT 1")
  [ "$n" = "1" ] || die "expected exactly 1 verified synthetic driver, found $n — run resolve/provision or set TEST_DRIVER"
  echo "$id"
}

pick_customer(){
  local t="$1"
  if [ -n "${TEST_CUSTOMER:-}" ]; then
    sql "SELECT 1 FROM public.profiles WHERE id='$TEST_CUSTOMER' AND role='customer' AND tenant_id='$t'" | grep -q 1 \
      || die "TEST_CUSTOMER=$TEST_CUSTOMER is not a customer in tenant $t"
    echo "$TEST_CUSTOMER"; return
  fi
  local n id
  n=$(sql "SELECT count(*) FROM public.profiles p WHERE p.role='customer' AND p.tenant_id='$t'
    AND (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic|example|\\.test$)'")
  id=$(sql "SELECT p.id::text FROM public.profiles p WHERE p.role='customer' AND p.tenant_id='$t'
    AND (SELECT u.email FROM auth.users u WHERE u.id=p.id) ~* '(test|synthetic|example|\\.test$)'
    ORDER BY p.id LIMIT 1")
  [ "$n" = "1" ] || die "expected exactly 1 verified synthetic customer in tenant $t, found $n — run provision or set TEST_CUSTOMER"
  echo "$id"
}

# ---------------------------------------------------------------------------
# PROVISION — canonical GoTrue signup only. Random one-time password generated
# with openssl, passed via container env (never in argv, never printed).
# Profile creation stays with the canonical onboarding trigger/flow.
# ---------------------------------------------------------------------------
provision(){
  local TENANT="$1" EMAIL_D EMAIL_C UD UC
  [ -n "$TENANT" ] || die "usage: provision <tenant-uuid>"
  sql "SELECT 1 FROM public.tenants WHERE id='$TENANT'" | grep -q 1 || die "tenant $TENANT not found"
  EMAIL_D="devtest-driver-$(date +%s)@synthetic.vaydu-develop.test"
  EMAIL_C="devtest-customer-$(date +%s)@synthetic.vaydu-develop.test"
  for pair in "driver $EMAIL_D" "customer $EMAIL_C"; do
    set -- $pair
    id=$(openssl rand -base64 24 | docker exec -i -e EMAIL="$2" -e ROLE="$1" "$API_C" node -e "
      const{createClient}=require('@supabase/supabase-js');
      let pw='';process.stdin.on('data',d=>pw+=d).on('end',()=>{
      const c=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
      c.auth.admin.createUser({email:process.env.EMAIL,password:pw,email_confirm:true,user_metadata:{role:process.env.ROLE,synthetic:true}})
        .then(r=>{if(r.error){console.error(r.error.message);process.exit(3)}console.log(r.data.user.id)})
        .catch(e=>{console.error(e.message);process.exit(4)});});")
    [ -n "$id" ] || die "GoTrue createUser failed for $1"
    eval "$([ "$1" = driver ] && echo UD || echo UC)=$id"
  done
  sleep 2
  sql "SELECT id::text,role,account_status FROM public.profiles WHERE id IN ('$UD','$UC') ORDER BY id" || true
  missing=$(sql "SELECT count(*) FROM (VALUES('$UD'::uuid),('$UC'::uuid)) v(id) WHERE NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v.id)")
  [ "$missing" = "0" ] || echo "NOTE: canonical onboarding did not create $missing profile row(s); complete app onboarding — no grants written."
  echo "provisioned users: driver=$UD customer=$UC (credentials not printed)"
}

# ---------------------------------------------------------------------------
# VERIFY-STRIPE — key-type check + supported test-mode provider op inside the
# api container. Account identity/capabilities: account-check (separate).
# ---------------------------------------------------------------------------
verify_stripe(){
  docker exec "$API_C" node -e "
    const Stripe=require('stripe');
    const k=process.env.STRIPE_SECRET_KEY||'';
    if(!/^[sr]k_test_/.test(k)){console.error('configured credential is NOT a test-mode key');process.exit(5)}
    console.log('key-type=test');
    const s=new Stripe(k);
    s.balance.retrieve().then(()=>{console.log('provider_access_ok=true');})
      .catch(e=>{console.error('provider access failed:',e.code||e.message);process.exit(4)});
  " || die "stripe provider verification failed"
}

account_check(){
  local ACCT
  ACCT="${TEST_STRIPE_ACCT:-$(sql "SELECT provider_account_id FROM public.driver_card_topup_sandbox_scopes WHERE enabled ORDER BY reviewed_at DESC LIMIT 1")}"
  [ -n "$ACCT" ] || die "no bound provider_account_id and TEST_STRIPE_ACCT unset"
  docker exec "$API_C" node -e "
    const Stripe=require('stripe');const s=new Stripe(process.env.STRIPE_SECRET_KEY||'');
    s.accounts.retrieve('$ACCT').then(a=>{console.log('account',a.id,'country',a.country,'charges',a.charges_enabled,'payouts',a.payouts_enabled);})
      .catch(e=>{console.error('account retrieve failed:',e.code||e.message);process.exit(4)});"
}

configure_plan(){
  cat <<'PLAN'
Planned writes — ONE advisory-locked transaction; ANY abort rolls back ALL:
 [MARKET-WIDE] market_payment_routes  stripe/GB/GBP: enable+approve+adapter_ready+collect.
               CONFLICT-ABORT: a stripe/GB/GBP route bound to a different
               merchant_account_ref aborts the whole transaction (not merged).
 [MARKET-WIDE] wallet_collection_config driver_card_sandbox_enabled=true,
               max_amount_minor_GBP=1000000.
 [MARKET-WIDE] wallet_topup_fee_schedules canonical 5% wallet fee row.
               CONFLICT-ABORT: a different ACTIVE fee for stripe/GB/GBP/card,
               or the canonical version row with different terms, aborts.
 [DRIVER-SCOPED] driver_card_topup_sandbox_scopes NEW reviewed row
               (insert-only, immutable). CONFLICT-ABORT: enabled scope for
               same driver/tenant/provider/country/currency with different
               merchant/policy/provider_account_id.
 [TENANT-SCOPED] campaigns DEVTEST5 5% customer_discount, cap 1, budget 50000.
               CONFLICT-ABORT: same code+tenant with different terms.
 [ASSERT]      post-conditions: scope + route binding consistent.
 NOT written: market_availability, balances, other providers, migrations,
              production.
PLAN
}

configure(){
  local DRIVER CUSTOMER TENANT MERCHANT ACCT
  DRIVER="$(pick_driver)"; [ -n "$DRIVER" ] || die "no designated driver"
  TENANT=$(sql "SELECT tenant_id::text FROM public.profiles WHERE id='$DRIVER'")
  [ -n "$TENANT" ] || die "driver $DRIVER has no tenant"
  CUSTOMER="$(pick_customer "$TENANT")"
  MERCHANT=$(sql "SELECT merchant_account_ref FROM public.driver_card_topup_sandbox_scopes WHERE enabled AND driver_id='$DRIVER' ORDER BY reviewed_at DESC LIMIT 1")
  [ -n "$MERCHANT" ] || MERCHANT='stripe-platform'
  ACCT="${TEST_STRIPE_ACCT:-$(sql "SELECT provider_account_id FROM public.driver_card_topup_sandbox_scopes WHERE enabled AND driver_id='$DRIVER' ORDER BY reviewed_at DESC LIMIT 1")}"
  [ -n "$ACCT" ] || die "no bound provider_account_id; set TEST_STRIPE_ACCT"
  verify_stripe
  echo "resolved: driver=$DRIVER customer=$CUSTOMER tenant=$TENANT merchant=$MERCHANT"

  sql "BEGIN;
   SELECT pg_advisory_xact_lock(hashtext('vaydu-develop-release-configure'));
   -- conflict checks first: abort instead of silently accepting mismatch.
   DO \$\$ BEGIN
     IF EXISTS (SELECT 1 FROM public.market_payment_routes
        WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP'
          AND merchant_account_ref IS DISTINCT FROM '$MERCHANT' AND merchant_account_ref IS NOT NULL) THEN
       RAISE EXCEPTION 'CONFLICT: stripe/GB/GBP route bound to different merchant';
     END IF;
     IF EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
        WHERE active AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card'
          AND version<>'vaydu-driver-card-5pct-wallet-v1') THEN
       RAISE EXCEPTION 'CONFLICT: different ACTIVE fee schedule for stripe/GB/GBP/card';
     END IF;
     IF EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
        WHERE version='vaydu-driver-card-5pct-wallet-v1' AND provider='stripe' AND country_code='GB'
          AND (fee_basis<>'wallet' OR fee_basis_points<>500 OR fee_fixed_minor<>0 OR rounding<>'half_up')) THEN
       RAISE EXCEPTION 'CONFLICT: canonical fee version has unexpected terms';
     END IF;
     IF EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
        WHERE enabled AND provider='stripe' AND country_code='GB' AND currency_code='GBP'
          AND tenant_id='$TENANT' AND driver_id='$DRIVER'
          AND (merchant_account_ref IS DISTINCT FROM '$MERCHANT'
            OR provider_account_id IS DISTINCT FROM '$ACCT'
            OR policy_version<>'vaydu-driver-card-5pct-wallet-v1')) THEN
       RAISE EXCEPTION 'CONFLICT: enabled scope with different binding/policy for driver';
     END IF;
     IF EXISTS (SELECT 1 FROM public.campaigns WHERE code='DEVTEST5' AND tenant_id='$TENANT'
        AND (kind<>'customer_discount' OR value_type<>'percent' OR value<>5)) THEN
       RAISE EXCEPTION 'CONFLICT: DEVTEST5 exists with different terms';
     END IF;
   END \$\$;
   INSERT INTO public.wallet_collection_config(key,value)
    VALUES('driver_card_sandbox_enabled','true'),('max_amount_minor_GBP','1000000')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
   UPDATE public.market_payment_routes
      SET enabled=true, merchant_approved=true, adapter_ready=true,
          capabilities=array(select unnest(capabilities) union select 'collect'::text)
    WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP'
      AND merchant_account_ref='$MERCHANT';
   INSERT INTO public.wallet_topup_fee_schedules
     (version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
    SELECT 'vaydu-driver-card-5pct-wallet-v1','stripe','GB','GBP','card',2,'wallet',500,0,'half_up','develop-release-batch',now(),true
    WHERE NOT EXISTS (SELECT 1 FROM public.wallet_topup_fee_schedules
      WHERE version='vaydu-driver-card-5pct-wallet-v1' AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card');
   INSERT INTO public.driver_card_topup_sandbox_scopes
     (provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
    SELECT 'stripe','card','GB','GBP','$MERCHANT','$ACCT',
           '$TENANT','$DRIVER','merchant','develop-release-batch',now(),
           'designated GB/GBP synthetic sandbox scope','vaydu-driver-card-5pct-wallet-v1',true
    WHERE NOT EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
      WHERE enabled AND provider='stripe' AND country_code='GB' AND currency_code='GBP'
        AND tenant_id='$TENANT' AND driver_id='$DRIVER');
   INSERT INTO public.campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,enabled,value_type,value,per_user_cap,budget_minor,qualification)
    SELECT '$TENANT','DEVTEST5','customer_discount','GB','GBP','ride','customer',true,'percent',5,1,50000,'{\"label\":\"designated develop test\",\"bounded\":true}'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM public.campaigns WHERE code='DEVTEST5' AND tenant_id='$TENANT');
   DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM public.driver_card_topup_sandbox_scopes
        WHERE enabled AND driver_id='$DRIVER' AND tenant_id='$TENANT'
          AND merchant_account_ref='$MERCHANT') THEN
       RAISE EXCEPTION 'designated sandbox scope missing for %', '$DRIVER';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM public.market_payment_routes
        WHERE provider='stripe' AND country_code='GB' AND enabled
          AND merchant_account_ref='$MERCHANT') THEN
       RAISE EXCEPTION 'stripe GB route binding % not enabled', '$MERCHANT';
     END IF;
   END \$\$;
  COMMIT;"
  echo "configured (advisory-locked, replay-safe): $TENANT"
}

# ---------------------------------------------------------------------------
# ADMIN-BUILD — real work: builds Angular develop explicitly, validates
# compiled targets, installs assets into movabi-develop-admin only.
# Requires the repo checkout path on this host as arg.
# ---------------------------------------------------------------------------
admin_build(){
  local SRC="$1" dist urls
  [ -n "$SRC" ] && [ -d "$SRC" ] || die "usage: admin-build <repo-dir-on-host>"
  cd "$SRC" || die "cannot cd $SRC"
  [ -f angular.json ] || die "$SRC is not the repo root"
  npm ci --silent || die "npm ci failed"
  npx ng build admin --configuration=develop || die "admin build failed"
  dist="dist/admin/browser"
  [ -d "$dist" ] || dist="dist/admin"
  urls=$(grep -rhoE 'https://[a-zA-Z0-9.-]+' "$dist" | sort -u)
  echo "$urls" | grep -q 'movabi-api-develop'    || die "assets missing movabi-api-develop target"
  echo "$urls" | grep -q 'movabi-supabase-develop' || die "assets missing movabi-supabase-develop target"
  echo "$urls" | grep -qE 'movabi\.apps|vaydu\.app' && die "assets contain PRODUCTION targets"
  html_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/usr/share/nginx/html"}}{{.Source}}{{end}}{{end}}' "$ADM_C")
  if [ -n "$html_mount" ]; then
    cp -rf "$dist/." "$html_mount/" || die "copy to html mount failed"
  else
    docker cp "$dist/." "$ADM_C":/usr/share/nginx/html/ || die "docker cp failed"
    echo "NOTE: assets copied into container fs; persists until recreate."
  fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$ADM_URL/" || echo 000)
  echo "admin index -> $code"
}

# ---------------------------------------------------------------------------
# ADMIN-CERT — diagnose the real mechanism, then apply its repair.
# ---------------------------------------------------------------------------
admin_cert(){
  local files svc wd
  docker inspect -f '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{"\n"}}{{end}}' "$ADM_C" | grep -iE 'traefik|cert|tls|router' || true
  local proxy='' p
  for c in $(docker ps --format '{{.Names}}' | grep -iE 'nginx|traefik|caddy'); do proxy=$c; p=$c; done
  if [ -n "$proxy" ]; then
    local img; img=$(docker inspect -f '{{.Config.Image}}' "$p")
    echo "proxy: $p ($img)"
    docker inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}}{{"\n"}}{{end}}' "$p"
    case "$img" in
      *traefik*)
        files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$ADM_C")
        wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$ADM_C")
        svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$ADM_C")
        [ -n "$files" ] && [ -n "$svc" ] || die "traefik host but admin labels missing"
        grep -RnE 'traefik|Host\(|certresolver' ${files//,/ } | grep -viE 'password|secret|token' || true
        echo "repair: ensure router rule Host(\`$ADM_HOST\`) + tls certresolver on service $svc, then:"
        echo "  cd $wd && docker compose $(for f in ${files//,/ }; do echo -n \"-f $f \"; done) up -d --force-recreate $svc" ;;
      *nginx*)
        local m; m=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d"}}{{.Source}}{{end}}{{end}}' "$p")
        [ -n "$m" ] || die "nginx conf.d not mounted; inspect $p manually"
        grep -l "$ADM_HOST" "$m"/*.conf 2>/dev/null || echo "no conf file contains $ADM_HOST"
        echo "repair: add server { listen 443 ssl; server_name $ADM_HOST; ssl_certificate ...; proxy_pass http://$ADM_C:80; } to $m, then: docker exec $p nginx -s reload" ;;
      *) echo "unrecognized proxy image $img — inspect manually" ;;
    esac
  else
    echo "no proxy container found; admin may publish TLS directly:"
    docker inspect -f '{{.HostConfig.PortBindings}}' "$ADM_C"
    docker inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}}{{"\n"}}{{end}}' "$ADM_C"
  fi
}

diagnose(){
  echo "===== A. PINNED VERSIONS ====="
  for c in "$DB_C" "$API_C" "$WEB_C" "$ADM_C"; do
    docker inspect -f '{{.Name}} image={{.Config.Image}} sha={{.Image}} created={{.Created}} running={{.State.Running}}' "$c"
  done
  echo "===== B. PROBES ====="
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/health" || echo 000)
  [ "$code" = "200" ] || die "required probe failed: $API_URL/health -> $code"
  echo "api /health -> $code"
  curl -sS "$APP_URL/" | grep -oE 'src="[^"]+\.js"' | head -5 || die "mobile index probe failed: $APP_URL"
  echo "-- admin TLS $ADM_URL"
  echo | openssl s_client -connect "$ADM_HOST:443" -servername "$ADM_HOST" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || echo "admin TLS probe failed (defect)"
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$ADM_URL/" || echo 000)
  echo "admin index -> $code (non-200 => admin cert/target defect to repair)"
  echo "===== C. COMPILED TARGETS (develop containers only) ====="
  for c in "$WEB_C" "$ADM_C"; do
    echo "-- $c"
    docker exec "$c" sh -c 'grep -rhoE "https://[a-zA-Z0-9.-]+" /usr/share/nginx/html 2>/dev/null | sort -u | head -15' \
      || die "compiled-target read failed in $c"
  done
  echo "===== D. GATE STATUS (allowlisted) ====="
  sql "SELECT 'sandbox_gate', public.driver_card_sandbox_enabled()" || true
  sql "SELECT 'route',provider,country_code,currency_code,enabled,merchant_approved,adapter_ready,merchant_account_ref FROM public.market_payment_routes WHERE provider='stripe' AND country_code='GB'"
  sql "SELECT 'fee',version,provider,method,fee_basis_points,active FROM public.wallet_topup_fee_schedules WHERE provider='stripe' AND country_code='GB'"
  sql "SELECT 'scope',driver_id::text,provider,enabled,policy_version FROM public.driver_card_topup_sandbox_scopes ORDER BY enabled DESC"
  sql "SELECT 'campaign',code,enabled,value_type,value FROM public.campaigns WHERE code='DEVTEST5'"
  resolve_ids
}

deploy_plan(){
  cat <<PLAN
===== DEPLOY SEQUENCE =====
1. Freeze v2.3 SHA; npm ci; images release-<sha>-r<n>; sha256sum -c on fresh extraction.
2. Migrations: delta only vs the 39 applied — never replay, never production.
3. Order: db delta -> movabi-develop-api -> movabi-develop-web -> movabi-develop-admin.
4. admin-cert repair per diagnosed mechanism; verify s_client + curl 200 on $ADM_URL.
5. Journeys: wallet sandbox top-up, campaign -> discounted quote, bike, PIN, referral.
PLAN
}

case "$MODE" in
  diagnose) diagnose ;;
  resolve)  resolve_ids ;;
  provision) provision "${2:-}" ;;
  verify-stripe) verify_stripe ;;
  account-check) account_check ;;
  configure-plan) configure_plan ;;
  configure) configure ;;
  admin-build) admin_build "${2:-}" ;;
  admin-cert) admin_cert ;;
  deploy-plan) deploy_plan ;;
  *) echo "usage: $0 diagnose|resolve|provision|verify-stripe|account-check|configure-plan|configure|admin-build|admin-cert|deploy-plan"; exit 64 ;;
esac
