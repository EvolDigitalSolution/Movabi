# Develop GB activation of the approved policy values

DEVELOP only, GB/GBP only. Production is untouched, and Africa providers stay deferred.

**Activation permission** is the user's standing instruction to enable completed features on develop.

## Approval source of every value

The same table is at the top of `activate-gb.sql`.

| Value | Where it is set | Approval |
|---|---|---|
| Cancellation fee £3.00, cap £3.00, grace 120 s after acceptance | `activate-gb.sql` (P1) | User, "Approve all proposals", 2026-11-14 |
| Driver compensation 80% on collection | `activate-gb.sql` | Approved before 2026-11-12 (matrix "Approved and recorded") |
| Customer debt threshold 50% of the GB ride minimum fare | `activate-gb.sql`; the minimum fare is read **live** from `pricing_config` | Approved before 2026-11-12 |
| Promo 5%, first booking, one per customer | `activate-gb.sql` | Approved before 2026-11-12 |
| Promo max £5.00, minimum fare £8.00, budget £500 | `activate-gb.sql` (P4) | 2026-11-14 |
| Referral 5% (customer and driver) | `activate-gb.sql` | Approved before 2026-11-12 |
| Referral cap £5.00, qualifying fare £8.00, budget £500 | `activate-gb.sql` (P5) | 2026-11-14 |
| Referral limits: credit 90 days, ≤5/month; driver 20 jobs in 30 days, ≤3/month, 7-day review | Database defaults and the redeem route; not set by the script | Approved before 2026-11-12 |
| PIN required for every GB service | `activate-gb.sql` (P6) | 2026-11-14 |
| Matching: acceptance 0.5, cancellation 1.0, new-driver exposure 0.15 km, review-score ranking on | `activate-gb.sql` (P7), GB key of `smart_matching` | 2026-11-14 |
| Road-ETA ranking off | Not changed (`VAYDU_TOMTOM_MATRIX_V23` stays off) | P7, 2026-11-14 |
| Surge: on, max 1.5, demand/supply on, traffic display-only, other multipliers 1.0 | `activate-gb.sql` (P8), GB key of `dynamic_pricing` | 2026-11-14 |
| Cash rides: card hold, immediate only, fixed fare | Existing cash code | Agreed 2026-11-12 (`CASH-BOOKING-PLAN.md`) |
| Cash terms `fare-split-v1` | `activate-gb-cash.sql` | Existing terms (`cash_credit_terms_v1e`); user: "reuse, don't ask again" |
| Map style (P9), fee above the cash hold → manual review (P13) | No change needed | 2026-11-14 |

## What the scripts do and what stops them

`activate-gb.sql` runs as one transaction and can be re-run safely. It **stops**, changing nothing, if:
- it is not run on `movabi_develop`;
- release 2 is not applied (referrals would pay wrong amounts);
- the GB/GBP ride minimum fare is not exactly one positive value;
- an enabled GB market strategy sets a maximum surge other than 1.5;
- GB AI pricing is live, because traffic could then change GB fares;
- a `FIRST5GB` or `REFERGB` campaign exists with terms other than the approved ones.

Settings change only their `markets.GB` key. Every other market and tenant-level value is kept.

`activate-gb-cash.sql -v driver_email=…` enrols exactly **one** GB driver, using terms `fare-split-v1`. It stops if:
- the email is not exactly one GB driver;
- the GB fee policy (P1) is not active, because the hold would then have no cap.

It also turns on the GB/GBP cash market and the global cash switch. Cash also needs `VAYDU_CASH_RIDE_BOOKING=true` on the API.

**What this means for other drivers** (rehearsed, `check-cash-activated.sql`):
- An unenrolled GB driver is refused a cash ride (CE002) and nothing is reserved from their credit. They still take card rides.
- NG drivers are unaffected: an NG card ride is accepted exactly as with cash off.
- No other market can enable cash. Release 2's VERIFY also refuses any cash market outside GB/GBP.

## Deactivation: what happens to existing obligations

`deactivate-gb.sql` and `deactivate-gb-cash.sql` stop **new** business only. Everything already owed or earned stays valid:

| Already in place when switched off | After deactivation |
|---|---|
| A cancellation fee frozen into a cancelled booking, and the customer debt it created (`customer_receivables`) | Stays **open** and payable. If it is collected later, the driver's 80% follows the frozen policy version. |
| A discount already applied to a quote | Kept: the booking is charged the discounted fare. |
| A referral reward already earned (`reward_credits`) | Kept in full until spent or expired (90 days). |
| A referral already linked | Still earns when the referee completes a qualifying ride. |
| A cash ride already accepted | Still completes. The driver's commission and fee reservation is **settled once**, and earnings are recorded with no transfer. |
| A cash ride cancelled after switch-off | Its reservation is **released in full**. The customer's card fee-hold row is kept for the server to release or capture under the normal rules. |
| The selected driver's cash enrolment and remaining credit | Kept. Nothing is refunded or moved. |
| Published policy versions, campaigns, settings history, audit rows | Kept. |
| New fee quotes, discounts, referral links, cash activations, GB PIN/matching/surge keys | **Stopped.** GB falls back to PIN required, the previous ranking and no surge. |

## Host steps

The exact sequence is in `RUNBOOK.md`, section "Release 2", step 5:
- run `host-live-config.sh` before and after;
- run `activate-gb.sql`;
- run `activate-gb-cash.sql` with the chosen driver's email;
- set `VAYDU_CASH_RIDE_BOOKING=true` and redeploy the API with the same bundle.

## Evidence

Local rehearsal on develop's live schema plus releases 1 and 2: `scripts/release/rehearse-release-2.sh`,
log `docs/roadmap-evidence/rehearse-release-2.log`.
- **Activation** (`check-activated.sql`):
  - GB only, applied twice with the same result;
  - a fee of 300 is due after grace, and none within 120 s;
  - an NG booking owes nothing;
  - promo: £12.50 gives 62, a second use is refused, £7.00 is below the minimum, £200 is capped at 500;
  - the P7 and P8 keys are present;
  - NG gets no setting.
- **Deactivation** (`check-deactivated.sql`): everything off, history kept, every obligation above still valid, new business refused, NG untouched.
- **Guards:**
  - a campaign with different terms stops the script;
  - a GB strategy with surge cap 2.0 stops it;
  - live GB AI pricing stops it.

  In each case no setting changes.
- **Concurrency** (real parallel database sessions):
  - two redemptions by the same customer at once: one discount;
  - three retries of one redemption: one row, budget charged once, the same answer each time;
  - budget 100 with two discounts of 62 at once: one applied, the other refused as "budget exhausted";
  - a burst of 8: one discount;
  - the same referral earned by three sessions: one credit of 75, budget charged once;
  - no campaign ever spends more than its budget.
- **Cash** (`check-cash-activated.sql`): only the selected driver can take a cash ride, nobody is blocked, and obligations are kept on deactivation.
