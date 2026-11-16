# Independent follow-up work (2026-11-16)

The f949a14 tooling archive was completed and checksummed before these feature changes.
None of this code is in that archive. No host commands, deployment, scope enablement or activation ran.
The single source of completion state remains ROADMAP_COMPLETION_MATRIX.md.

## P3 verification

`python scripts/release/test-debt-followup-realdb.py`: PASS on an owned, network-isolated
postgres:16.15 container. Existing customer_receivables, notifications and audit_logs table
definitions and primary keys were extracted from the committed develop-live schema, then
20261270300000 was applied. This is a focused transaction test, not a full host-schema rehearsal.

- Exact 24-hour and 30-day thresholds, with too-young debts excluded.
- Enabled tenant/GB/GBP scope required; disabled tenant, NG market, other currency and missing market excluded.
- Paid debts excluded; disputed debts reach review but receive no chase reminder.
- Existing review flags preserved; all other receivable fields remain byte-identical.
- One durable inbox reminder and one review event per debt; repeated runs add nothing.
- A forced notification INSERT failure rolls back the deduplication row; retry saves exactly one reminder.
- Four parallel database connections process 20 debts with exactly 20 actions and 20 notifications.
- anon/authenticated cannot invoke the processor or read its tracking table; service_role can invoke it.
- Invalid batch limits and non-GB scope creation are rejected.

`npx vitest run src/testing/debt-followup.spec.ts src/testing/approved-followup-policies.spec.ts --reporter=verbose`:
17/17 PASS (five worker tests, twelve policy tests).

`npx vitest run src/testing/customer-debts-routes.spec.ts src/testing/admin-receivables-resolve.spec.ts --reporter=dot`:
19/19 PASS.

`npx tsc --project server/tsconfig.json --noEmit`: PASS.

`npx ng build admin`: PASS (222.434 seconds). Existing warning: unused RouterLink import in DriverWalletPage.
The new admin badge compiles. A real-browser/develop reminder journey remains unverified.

P3 sends a persisted in-app reminder, not an asserted external push/email delivery. No charges,
interest, late fees or account suspensions are introduced. The worker requires both
VAYDU_DEPLOYMENT_ENV=develop and VAYDU_DEBT_FOLLOWUPS=true, plus explicit enabled DB scopes.
The migration inserts no scopes. It does not alter the approved existing booking threshold.

## P10/P11/P12 verification limits

The policy module is not yet a runtime detector, bonus payer or fee-waiver path. Its tests cover:

- P10: one-hour country and 24-hour distinct-device windows; over-200-km/ten-minute travel;
  invalid/future data, date-line geometry and tenant/user/market isolation. Action is review only.
- P11: 25 distinct completed GB/GBP rides; GBP 20 award and GBP 200 budget constants;
  tenant/driver/service/status isolation and London civil-week boundaries across both DST changes.
  The returned budget is policy metadata, never an authority to spend. Reservation/payment remain unbuilt.
- P12: structured codes, strictly over ten minutes late, at least five stationary minutes;
  missing evidence, wrong-vehicle/safety claims and free-text rejection. Classification never waives a fee.

Remaining integration work is recorded in T3/T4/T10. No approval is inferred for new money or
enforcement behaviour. Recorded policy approvals are reused; no repeated policy questions.
