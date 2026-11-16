# P8 strategy reconciliation verification (2026-11-16)

User scope: four existing GB strategies, cap 1.5, demand/supply enabled, traffic display-only,
other multipliers 1; retain AI shadow, IDs and unrelated fields, NG and other markets. No new
pricing decision. No live host access, SSH retry, deployment or activation was performed.

## Trace findings

- The actual resolver is country/service/currency scoped, with vehicle-specific city+zone/city/
  zone/national attempts before general-vehicle attempts. Validity and updated_at are respected.
  There is no tenant column/filter on strategies. The four GB rows affect every GB tenant that
  resolves their market/service scope, not NG quotes under a shared tenant.
- The strategy cap overrides the tenant dynamic cap. Fixed normal/busy overrides can bypass
  the existing demand/supply curve. Correct only cap=1.5, normal=1.0, busy=NULL on captured IDs.
- Tenant settings fall back to platform defaults. A newly inserted GB-only tenant setting can
  hide existing non-GB defaults. Preserve current effective platform objects in audited tenant
  rows before running the original markets.GB activation body. Global rows are never changed.
- Market intelligence and Global AI pricing have distinct shadow controls. Both are inspected;
  neither is changed. The original activation guard/body and four quote calculators are unchanged.
- The booking payload has no tenantId. Two API routes and one new helper bind signed-in GB
  quotes to a session-verified customer/driver tenant, behind a tenant-specific switch enabled
  atomically with the correction. Blank/NULL registration falls back to profile country. NG
  routing and preactivation context remain unchanged. The isolated API candidate uses f949a14
  plus these three source paths; no unfinished branch followups, web or release SQL changes.

## Focused checks

`npx vitest run src/testing/gb-p8-reconciliation.integration.spec.ts src/testing/market-dynamic-pricing.spec.ts --reporter=verbose --silent`

**14/14 passed**, two files: seven PostgreSQL/actual-engine cases plus seven existing market
dynamic tests. The SQL correction ran on an owned network-isolated PostgreSQL 16.15 instance
with actual baseline table definitions. PricingService, MarketplaceConfigService, the actual
strategy resolver, market intelligence and GlobalAiPricingService all ran without calculator or
resolver stubs; the transport used snapshots from that DB. Quote audit persistence was isolated.

- A synthetic fixed busy=2.5/cap=3 bypass is reproduced, then corrected to demand-driven 1.1 for
  moderate demand and <=1.5 for high demand/no supply. Normal demand remains 1.0.
- Four services x two GB tenants x four demand/supply conditions, ordinary and stressed traffic/
  weather, exercise canonical payable prices and AI shadow. Traffic/weather do not increase fares.
- Strategy IDs, timestamps, commission, floors, type, scopes, enabled/validity fields and all other
  columns compare unchanged; AI rows, NG/FR strategies and NG quote components remain unchanged.
- An absent tenant setting inherits existing platform defaults. The original settings activation
  body creates its GB key while actual NG payable quotes and platform rows remain identical.
- Vehicle-vs-city/zone precedence, currency filtering, validity, stale/extra manifests, shadow loss,
  unexpected timestamp triggers and audit atomicity are tested.
- Preflight reports simultaneous missing functions, AI controls, NULL campaign terms and P8
  overrides together, with no business writes. SQL errors are reported as blockers.

Fixture values are synthetic failure cases, not claims about current host strategy amounts.
Actual row IDs and data come from the operator's captured manifest.

**25/25** tenant-helper, real Express quote-route wiring and existing country-resolution tests
pass. They cover omitted/spoofed tenant IDs, reused verified map identity, blank/NULL profiles,
foreign/anonymous routing, disabled activation switch and invalid/missing identities. Server
typecheck passes. Calculator tests above use the real engines; route wiring tests mock only the
calculator/auth/database boundaries to observe the trusted tenant supplied to those engines.

## Full composite rehearsal

`bash scripts/release/rehearse-release-2.sh supabase/baseline/develop_live_public_schema_20261112.sql`

**REHEARSAL 2 PASSED**, including the added P8 composite checks:

- Existing nine behaviour suites, migration failure atomicity, exact rollback, inspection-data/
  grants preservation, activation twice, money/concurrency and cash-cohort isolation checks.
- Aggregate preflight finds simultaneous minimum, campaign, policy and both shadow conflicts,
  including a second GB tenant's stale derived threshold in the synthetic fixture.
- After explicit test-fixture repairs, no hard blockers remain; only the known P8 reconciliation
  is classified correctable. No such financial repairs are included in the operator correction.
- The actual composed SQL executes correction, audited default inheritance and the unchanged
  activation body with ROLLBACK; strategy state is unchanged afterwards.
- The same composition with COMMIT produces four audited strategy corrections. End-of-transaction
  assertions preserve other markets, profiles, pricing, AI and unrelated settings/financial history.
- GB AI enabled/shadow stays true/true. A missing GB tenant setting retains platform NG defaults
  2.4/2.2 while its GB cap becomes 1.5.
- Native GB quote-tenant binding is enabled for all activated tenants in that same transaction.

Host tools retain snapshots, combined SQL, preflight, dry run and before/after actual installed-
service quotes. Other-market payable components (or existing unavailable errors) must compare
equal. API-source fingerprints, unchanged full release VERIFY and the prior real-backup drill
are gates. This local evidence does not establish deployment, provider sandbox or a live journey.
