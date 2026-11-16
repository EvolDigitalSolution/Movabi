# Develop legacy UK pricing scope correction (2026-11-16)

Live evidence supplied by the user: four active national GBP pricing rows have blank country
codes; the ride minimum is **GBP 3.35**. NG pricing is explicitly scoped and must be unchanged.
This is an explicit correction of those intended UK rows, not a new pricing decision.

## Why quotes work and activation stops

`PricingService.resolveUnprotectedPrice()` calls
`MarketplaceConfigService.getEffectivePricingConfig()` before regional/fallback pricing. That
lookup fetches active service rows, then filters country, currency, city and zone in JavaScript.
`String(row.country_code || 'GB').trim().toUpperCase()` treats NULL and empty-string countries
as the historical GB default; an explicit NG row matches only NG. Requested currency is also
filtered. A whitespace-only country becomes an empty string after trimming and currently acts
as a wildcard in that lookup. No runtime fallback or country inference is added by this fix.

The activation minimum-fare guard deliberately requires explicit GB/GBP pricing. Blank countries
therefore give it zero rows even when the quote engine selected the legacy row. **The guard is
unchanged.** Correcting the four intended rows to explicit GB aligns the data with it.

The unique pricing index uses COALESCE(country_code,'GB') but does not normalise empty strings,
case or country whitespace. The correction checks normalised GB national conflicts itself,
including inactive rows; it never replaces a conflicting row or changes its rate.

SQL COALESCE(registration_country_code,country_code) has another mismatch: an empty registration
country masks country_code. Both activation lookups now use NULLIF(BTRIM(...),'') before
COALESCE. A nonblank registration country still takes precedence. No profile data is rewritten.

## Correction invariants

`correct-legacy-gb-pricing.sh` captures the complete intended-row JSON and row IDs, records the
running API image/source, recognises existing GB customer/driver profiles, and runs the actual
installed pricing services for GB and explicit NG pricing before and after the correction.
It checks each service with zero distance/time and with 5 km/10 min, using the same requestedAt,
tenant, demand/supply and other inputs. Quotes may write normal quote audit records; they never
book a job, authorise, capture or transfer money. No routing/geocoding provider call is added.
NG probes use the explicitly configured NG currencies/city/zone; they never borrow UK currency.

`correct-legacy-gb-pricing.sql` is one transaction and refuses any shape other than four distinct
active national GBP rows, one each for ride/delivery/errand/van-moving, with ride minimum 3.35.
The operator-captured ID manifest must still match every stored field. This is not an UPDATE of
all GBP pricing, nor a reusable currency-to-country mapping.

It locks pricing writes, temporarily disables only the known updated_at trigger, changes only
country_code on those IDs and restores that trigger's exact O/A/R/D mode. Full-row comparisons
prove IDs, rates, minimums, updated_at, every other field, all NG/unrelated rows and all trigger
definitions/modes are preserved. Unexpected trigger side effects roll the transaction back.
Each corrected row gets an audit_logs entry with complete before/after records, session user,
transaction ID and source. A SQL rerun with the same original snapshot is idempotent only when
all four rows already have the corresponding audit evidence; unaudited or partial states fail.

The wrapper then compares full pricing snapshots and full actual quote results. On a mismatch it
stops before activation and retains evidence. The already committed, audited scope correction
is not blindly reversed over concurrent operator work. All evidence is in the printed
`/home/edsadmin/vaydu-gb-pricing-scope.*` directory, including the original input JSON.

## Host correction and activation rerun

Use the small checksummed `vaydu-gb-scope-fix-<commit>.tar.gz` artifact. It contains only these
tools and corrected activation scripts. API, web and release-up/down/dryrun SQL are not included
or changed. The existing f949a14 archive remains immutable.

Upload and checksum-verify the fix archive, extract it into a new directory and set FIX_DIR to
its extracted root. Run:

```bash
(cd "$FIX_DIR" && sha256sum -c FIX_SHA256SUMS)
bash "$FIX_DIR/correct-legacy-gb-pricing.sh"
```

Required results: `PROFILE_MARKETS_OK`, `PRICING_SCOPE_CORRECTION_OK changed=4`,
`ALL_PRICING_FIELDS_PRESERVED`, `GB_NG_QUOTES_UNCHANGED`, `PRICING_SCOPE_HOST_OK`.
Any failure stops the script with a nonzero status. It does not activate anything.

**Activation remains subject to the existing corrected real-backup drill/release verification
gate.** Once those have passed, rerun the corrected activation copy from this fix artifact:

```bash
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off' < "$FIX_DIR/activate-gb.sql"
```

This retains all existing release, minimum-fare, surge/AI and campaign-term guards. The reference
fare is read live as 335 minor units. The existing publish function's 50% integer calculation
is unchanged. No fee/rate/minimum or other pricing policy is newly chosen here.

If the existing selected cash driver's activation also needs rerunning, use the corrected
activate-gb-cash.sql and the **same recorded driver_email**; this fix does not choose or enrol
another driver and does not change the API cash flag. Production and Africa integration remain
untouched; GB Stripe, inspection enforcement and Mapbox permanent=false are unchanged.

## Regression

`npx vitest run src/testing/legacy-gb-pricing-scope.integration.spec.ts src/testing/market-fare-country-v23.spec.ts --reporter=verbose --silent`

The focused PostgreSQL test uses the live-schema pricing table, unique index and timestamp
trigger definitions. Four synthetic GBP rows reproduce the exact reported blank-country shape
and ride minimum 3.35; NG has explicit rows. Other fixture rates are test values, not proposed
live prices. It runs the real lookup and quote calculator, with only transport and unrelated
dynamic/fee/market settings controlled. It proves identical GB/NG quotes, unchanged row bytes,
guard failure/success, auditing/idempotence, stale/conflicting-data refusal, NULL handling,
profile precedence, all timestamp-trigger modes and atomic rollback of unexpected side effects.
Actual host pricing/settings are checked separately by the wrapper, never claimed from mocks.

The full `scripts/release/rehearse-release-2.sh` rehearsal also passes with the existing GB
customer's registration country blank and selected driver's registration country NULL. It
retains its separate GBP 3.00 synthetic fixture (not the host minimum); the focused regression
above covers the live-evidenced GBP 3.35 shape. Full activation twice, NG isolation, all nine
behaviour suites, rollback, campaign/surge/AI guards and cash-driver activation pass. Neither
fixture changes any live price. Live execution remains pending operator host output.
