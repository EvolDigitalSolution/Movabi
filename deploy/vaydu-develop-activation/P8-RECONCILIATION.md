# Develop P8 strategy reconciliation and complete activation preflight

P8 was approved on 2026-11-14: GB maximum surge 1.5, demand/supply on, traffic display-only,
all other multipliers 1. No new pricing decision. The four existing GB strategies are captured
by ID and full row; actual values/IDs are never guessed from synthetic test data.

## Precedence and scope traced before editing

PricingService first resolves pricing_config, then resolveMarketPricingStrategy. Strategy
selection requires exact country, canonical service and currency, enabled=true and valid dates.
It tries vehicle-specific city+zone, city, zone, national; then the same sequence with no vehicle.
Thus a vehicle-specific national row precedes a general city/zone row. Latest updated_at wins
within the selected scope. The strategy table and resolver have **no tenant filter**: its GB rows
apply across tenants for that market/service, not to NG merely because a tenant is shared.

Dynamic settings resolve tenant first, otherwise the latest platform row. A markets.GB entry
uses its own values over safe defaults, not the tenant's unrelated legacy multipliers. Strategy
maximum_surge_multiplier overrides the dynamic setting's cap. Strategy normal_demand_multiplier
and busy_multiplier also override the demand/supply curve. Merely changing markets.GB or the
cap would leave a fixed busy override in place.

The correction therefore sets only these three fields on the four captured GB/GBP strategy IDs:

- maximum_surge_multiplier = 1.5;
- normal_demand_multiplier = 1.0;
- busy_multiplier = NULL, meaning use the existing demand/supply calculation, not a new fixed rate.

IDs, timestamps/priority, commission, floors, strategy type, scope, enabled state, validity and
all other fields are preserved. Additional GB rows/scopes, stale manifests or unexpected trigger
changes stop the correction. All other-market strategy rows remain identical. Full before/after
strategy records, approval, session user and transaction ID are audited.

Both AI controls remain unchanged: pricing_markets.shadow_mode_enabled and the platform market
intelligence shadow setting. An unexpected live/ non-shadow state is reported, not silently changed
globally. Market intelligence can otherwise adjust the service fare after dynamic pricing;
GlobalAiPricingService can recommend a traffic-related shadow price but cannot replace the GB
protected canonical payable price. The probe verifies the latter, not just the stored cap.

## Preserving inherited defaults

Creating a GB-only tenant row can hide platform defaults previously used by the same tenant's NG
quotes. Before the unchanged activation body runs, missing tenant rows for its three setting keys
inherit a copy of the **already effective** platform object. That inheritance is audited. Activation
then changes only markets.GB. Existing tenant/platform row IDs and platform values are untouched;
non-GB effective values are compared against the captured defaults. This does not invent or enable
another market's policy. Malformed or duplicate fallback objects are reported for review.

## One complete inspection, not repeated first-error attempts

reconcile-gb-p8.sh verifies its artifact and the installed API's seven calculator/route/helper
modules, records API source/image, runs the unchanged full release-2 VERIFY, and reports all
known activation prerequisites together. Each independent SQL inspection catches missing schema
as BLOCK; errors never become PASS. The checks cover:

- Develop database, release functions/fingerprint and full release VERIFY.
- Existing GBP 3.35 ride minimum, remaining four-row legacy-country shape and explicit GB conflicts.
- GB customer/driver recognition, blank/NULL handling and tenant scope.
- All four strategy IDs/scopes, P8 overrides, triggers and write privileges.
- Both AI shadow controls, duplicate settings, tenant and effective-platform object shapes.
- Both campaigns' complete approved terms and validity; exhausted budgets/usage limits are information,
  never reset or increased.
- Existing cancellation-policy skip behaviour and the actually effective version. A higher/future
  conflicting version or stale derived threshold is reported before the activation can skip it.
- Separate cash flag and ops-recipient/SMTP readiness information; neither is changed by this command.

Only the already approved P8 fields and, if still needed, the previously reviewed four-ID legacy
UK country correction are automatically correctable. Unknown campaign/policy/AI/scope conflicts
are all reported before any persistent change; no financial history or unrelated policy is repaired
by guesswork. The minimum stays 3.35. The existing integer 50% threshold rule is unchanged.

When SQL preconditions permit, the entire projected correction + inheritance + **unchanged
activate-gb.sql body and guards** runs as one transaction ending in ROLLBACK. Then --apply runs
the same transaction with COMMIT, after the recorded real-backup gate and baseline quote probes.
Late activation or isolation failure rolls back the correction too. Pricing, strategies, AI,
profiles, settings, existing campaigns and policies are checked for unintended changes before commit.

## Host commands

Current verified baseline (superseding the earlier c972037/3c91991 inventory): API f949a14,
web movabi-web:release-f949a14-linux. Inspection evidence supplied by the operator:
/home/edsadmin/vaydu-p8-reconciliation.Q8xr7I. No SSH retry is used to read that remote path.
Each new inspection verifies served web bytes and exact file inventory against manifests
derived from the checksum-pinned f949a14 bundle, checks the exact tag and its running image ID,
and records actual web image/container IDs. Rollout checks those identities remain unchanged.
The prior passing real-backup evidence is reused and its path/hash recorded in fresh evidence.
See P8-RECOVERY.md for the API-deployed/activation-failed boundary and exact-image recovery.

The actual booking client sends its session token but no tenantId. The paired API binds signed-in
GB customer/driver quotes to the verified profile tenant, skipping blank registration country
before country_code. Body tenant/user IDs cannot override the verified identity. A per-tenant
quote_tenant_binding.markets.GB switch is enabled only in the same transaction as P8 activation.
Before that switch, legacy routing remains in effect. Foreign-market routing is unchanged.

The paired API is the unchanged reviewed eef726b archive, using immutable f949a14 as its base with exactly two route changes and one new
helper. Calculators, web and release SQL are byte-identical to that base. Unfinished P3/P10/P11/
P12 branch changes are excluded. Do not deploy the current branch wholesale or use the nested
base artifact's older activation copy: use these operator tools.

Upload/checksum-verify vaydu-gb-p8-fix-<commit>.tar.gz and extract into a new directory. Set F to
its extracted root. The API-only rollout preserves the existing web image and requires the
recorded real-backup drill gate and successful projected SQL first. No new backup or SSH retry.

```bash
bash "$F/reconcile-gb-p8.sh" --inspect
bash "$F/deploy-p8-api.sh"
bash "$F/reconcile-gb-p8.sh" --apply
```

--inspect reports all available blockers and, when SQL is ready, the full rolled-back projection.
--apply repeats those checks, then commits and probes actual installed-service quotes. It reuses
the newest passing drill.log under the earlier /home/edsadmin/vaydu-f949a14-drill.* gate directories.
For another already-recorded location, set RESTORE_DRILL_LOG to that existing passed log. If none
passes, --apply refuses to commit; no new backup/drill is requested by this tool.

Expected: P8_FULL_ACTIVATION_DRYRUN_OK, P8_ACTIVATION_ISOLATION_OK,
OTHER_MARKET_QUOTES_UNCHANGED, P8_ACTUAL_QUOTES_OK and P8_RECONCILIATION_ACTIVATION_OK.
All snapshots, aggregate report, full composed SQL, dry-run/apply output and quotes are retained
in the printed /home/edsadmin/vaydu-p8-reconciliation.* directory. A failed probe exits nonzero;
retain the evidence and stop further rollout. The tool does not blindly overwrite later operator
work or erase already recorded obligations.

## Verification scope

The installed quote probe uses the actual strategy resolver, tenant configuration, PricingService
and GlobalAiPricingService, including native other-market tenants and GB tenants sharing those
markets. It exercises zero/moderate/high demand and no supply, with traffic/weather 1 versus 9.
It checks dynamic/service-fare surge <=1.5 (allowing normal penny rounding), actual demand/supply
results, unchanged GBP payable price when only traffic/weather vary, and AI shadow equivalence to
the canonical protected price. Fixed fees, payment protection and driver obligations are not cut
to enforce an artificial total-price ratio. Other-market payable components/errors compare equal
before/after; an unavailable foreign market is not made available just to pass this GB correction.

Local verification: 14 pricing tests pass (7 real-PostgreSQL/actual-engine cases plus 7 existing
market-dynamic tests), plus 25 route/tenant/country tests. Full release-2 rehearsal tests aggregate simultaneous conflicts,
the actual composed dry run and atomic apply, platform-default inheritance, all nine behaviour
suites, atomic tenant-binding activation and schema rollback. Server typecheck passes. Host output remains required; local transport tests are not labelled
as live provider, browser or develop verification. Production, GB Stripe, inspection enforcement,
Mapbox permanent=false and deferred Africa integrations are untouched.

Baseline-tooling correction adds six isolated regressions of the actual shipped web guard:
verified bytes/IDs accepted; old tag, retagged image, modified, missing and extra files refused.
Packaging rechecks both archive manifests and the complete candidate/base difference set;
the nested eef726b API archive is reused byte for byte. SQL and API source are unchanged by
this tooling correction, so their earlier 39 tests and nine-suite rehearsal remain applicable.
Three recovery regressions also refuse active bindings, failed DB inspection and wrong project
without issuing a Docker mutation.
