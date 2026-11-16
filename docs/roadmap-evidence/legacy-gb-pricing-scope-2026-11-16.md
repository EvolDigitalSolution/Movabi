# Legacy UK pricing activation mismatch (2026-11-16)

User live evidence: four legacy GBP national rows have blank country; ride minimum GBP 3.35;
NG rows have explicit country scope. No host access or SSH attempt was made for this fix.
Live deployment/activation is not inferred from the reported activation error.

Trace: PricingService.resolveUnprotectedPrice -> MarketplaceConfigService.getEffectivePricingConfig.
The latter reads active canonical-service rows and filters currency/city/zone plus the legacy
country default. NULL and empty-string country values become GB through `row.country_code || 'GB'`.
Whitespace-only countries become blank after trim and can act as wildcard. The explicit activation
GB/GBP guard does not match those rows. The runtime lookup and activation price guard are unchanged.

The separate transaction accepts an exact four-ID full-row snapshot, refuses country-scope
conflicts and stale fields, updates country_code only, restores the timestamp trigger's exact
mode and asserts all other pricing fields/NG rows unchanged. Four full before/after audit records
are written. Blank/NULL registration country handling is corrected in both activation lookups,
without changing registration-country precedence or mutating profiles.

## Focused regression: PASS

Command:
`npx vitest run src/testing/legacy-gb-pricing-scope.integration.spec.ts src/testing/market-fare-country-v23.spec.ts --reporter=verbose --silent`

Result: **2 files, 11 tests passed** (10 PostgreSQL integration cases; existing market-fare test
also runs its 10 lookup/guard assertions). Owned network-isolated PostgreSQL 16.15 container;
existing table/index/trigger definitions extracted from the committed live schema. Full row
comparison includes updated_at. Four synthetic blank-country GBP rows reproduce the reported
shape and 3.35 ride minimum; explicit NG rows coexist. Other fixture rates are synthetic test
values and are never written to the host by these tools.

- Activation minimum guard refuses the before-state and reads 335 minor units after correction.
- 16 actual pricing-service quote cases (four services, two trip sizes, GB and NG) compare equal
  before/after; actual effective lookup, floor, rate calculations and payment protection run.
  Transport and unrelated dynamic/fee/market settings are controlled in this local test.
- Four audits, exact before/after bodies, same-snapshot idempotence and unchanged NG/full rows.
- Blank, NULL and whitespace registration countries recognise GB customer/driver tenants;
  nonblank NG registration retains precedence over country_code=GB. Cash lookup tested too.
- Normalised GB conflicts, stale inputs, wrong counts, changed minimum, unaudited GB states and
  non-develop DB are refused with no data correction.
- Original timestamp trigger modes O/A/R/D are restored. An unexpected rate-mutating trigger
  causes a full transaction rollback, including audit writes and trigger state.

## Full release-2/activation rehearsal: PASS

`bash scripts/release/rehearse-release-2.sh supabase/baseline/develop_live_public_schema_20261112.sql`

Result: **REHEARSAL 2 PASSED**. Includes all nine behaviour suites, exact schema rollback,
inspection-data/grant preservation, activation twice, NG isolation, cash activation for the
existing selected test driver, compensation/debt/campaign checks and unchanged campaign,
surge-cap and live-AI guards. Its historical GBP 3.00 fixture remains a separate scenario;
the exact reported 3.35 shape is covered by the focused regression above.

Bash syntax check and Node syntax checks for the host wrapper/probes pass. The host wrapper
uses installed API code and live database settings for actual before/after GB and explicit-NG
quotes. It requires those quotes plus full pricing JSON to compare equal and retains evidence.
This host check is prepared, not claimed as run. The real-backup/deployment gate still applies.
