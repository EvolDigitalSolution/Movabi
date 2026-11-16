# Completion PIN: explicit African defaults off, GB required

User approval: 2026-11-16. Develop only. Repository African market catalogue:
**NG GH KE ZA UG TZ RW MW EG CM CI SN ZM**. These explicit country entries become disabled;
GB becomes required. FR/US/IN/AE and unknown countries are not classified as Africa. No currency,
continent guess or non-GB rule. Unsupported/unlisted markets retain their prior policy until
explicitly configured; this change neither opens a market nor enables a payment provider.

The existing TS marketPinPolicy resolver reads these entries at booking. At the **first unfrozen
driver assignment**, a new zy_ preparation trigger refreshes the explicit market entry before
the unchanged zz_stamp_completion_pin_policy trigger runs. It uses the existing SQL
completion_pin_market_policy resolver (bad values fail closed), then the original stamp trigger
applies the authorised same-tenant driver override and freezes the result. A tenant's explicit
country entry wins; if missing, the platform's approved country default applies. Generic tenant
defaults cannot hide the approved country default for newly provisioned tenants.

No existing job row, secret or driver override is changed. Already assigned/frozen jobs and
same-driver status updates keep their policy; reassignment retains the existing stored market
policy and original driver-override handling. All assignment/ownership/readiness, payment,
PIN-attempt/replay and settlement functions/guards are unchanged. The apply transaction asserts
that all existing functions, existing jobs, secrets, overrides and unrelated setting fields/
markets remain identical. Full before/after settings, approval, operator and transaction are
audited. The new function definition is audited as well. Reapplying is safe and does not duplicate
unchanged policy-change audit rows.

This is a DB-only release: no API/web rebuild or restart. The host script verifies f949a14/eef726b
API source and four pinned relevant modules, verifies the exact release-f949a14-linux web content
and image ID, and runs the existing full release VERIFY. It requires existing passing corrected
real-backup evidence before apply; no new backup or repeat drill. It dry-runs the complete policy
transaction with ROLLBACK, then applies and verifies explicit settings, helper trigger, privileges,
audit and original release fingerprints. API/web image and web container IDs must remain equal.

After checksum-verifying/extracting the release artifact into a fresh directory, set F to its root:

```bash
bash "$F/deploy.sh" --inspect
bash "$F/deploy.sh" --apply
bash "$F/deploy.sh" --verify
```

RESTORE_DRILL_LOG can name the existing passing log; otherwise the script finds the prior
/home/edsadmin/vaydu-f949a14-drill.*/drill.log evidence. The existing backup remains
/home/edsadmin/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T201704Z.dump.

Verification evidence is printed as PIN_POLICY_EVIDENCE. A transaction error rolls back both
DDL and settings/audits. A post-commit verification error requires investigation; do not restore
a backup or reset financial history. Already accepted jobs keep their frozen policy even if a
future separately audited policy correction changes the defaults again.

Local coverage: completion service tests prove eligible NG completes without a PIN; GB missing/
wrong PINs reject before settlement; correct PIN succeeds; unassigned/wrong-owner/not-ready jobs
still reject. Provider readiness/DB transport are controlled test fixtures, not live Africa
provider evidence. Real PostgreSQL tests cover first assignment of old pending bookings, same-
tenant overrides, foreign-tenant isolation, generic tenant fallback, FR unchanged, frozen jobs,
audit/privileges and the unchanged settlement RPC's exactly-once payout/earnings on retry.
Full release rehearsal retains all nine original behaviour suites and exact rollback.

Host verification is read-only; it never creates fake live jobs or payment transfers. Existing
payment/provider readiness remains required for a real NG completion. This PIN policy does not
authorise or enable the deferred Africa-provider integration. Production, GB Stripe, inspection,
multi-region isolation and Mapbox permanent=false remain unchanged.
