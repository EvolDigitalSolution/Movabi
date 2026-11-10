# Code-to-schema dependency checklist (candidate 96b907b + PIN migration)

Method: probe `supabase/baseline/deployed_public_schema.sql` for
`CREATE TABLE public.<name>` / `CREATE FUNCTION public.<name>`, then check the
bundle `ORDER.txt` for coverage. Feature scope is the frozen Bike/cash release;
roadmap items not shipped are marked out of scope, not silently omitted.

| Feature (shipped code) | Required object/definition | In develop export | In manifest | Verdict |
|---|---|---|---|---|
| Completion PIN | `job_completion_secrets` table | **yes** | — | satisfied by export |
| Completion PIN policy | `effective_completion_pin_policy(uuid,uuid,boolean)` | **no** | **added `20261103000000_completion_pin_policy.sql`** | **gap closed** |
| Completion PIN attempts | `record_pin_attempt(uuid,text,text)` | **no** | **added `20261103000000_completion_pin_policy.sql`** | **gap closed** |
| Driver metrics/ranking | `driver_ranking_scores_v23(uuid[])` | **yes** | — | satisfied by export |
| Referrals/campaigns (policy deps) | `referrals`, `campaigns` | **no** | `20261105000000_campaigns_referrals.sql` | covered by manifest |
| Refunds | `refund_operations` table, `claim_job_settlement`, `reserve_job_refund` | **yes** | — | satisfied by export |
| No-show settlement | `record_no_show_settlement` | **yes** | — | satisfied by export |
| Driver card fee/sandbox | `wallet_topup_fee_schedules`, `driver_card_topup_sandbox_scopes` | **no** | `20261254400000`, `20261254500000` | covered by manifest |
| Cash credit reservation | `driver_cash_credit_holds_v1e` | **yes** | `20261263000000` (multi-hold/status) | covered by export + manifest |
| Quote/create | `quote_market_adjustments` | **yes** | — | satisfied by export |
| Vehicle inspection (6 slots) | no inspection table function anywhere | **no** | **none** | **not shipped — out of scope for this release; requires a new feature migration** |
| Promotions v2 | `20261255800000_promo_policy_v2.sql`, `20261255900000_reward_credit_spends.sql` | n/a | not included | **out of scope (no new features); campaigns/referrals tables only satisfy the policy dependency** |

## Required follow-up for inspection

The inspection feature has no schema or migration in the repository. Shipping it
requires a new reviewed migration (slots, private storage path, review state) and
is explicitly outside this frozen bundle. The deployed smoke list therefore marks
inspection as **not applicable to this release** rather than pretending coverage.
