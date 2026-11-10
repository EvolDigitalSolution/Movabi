# Complete ordered candidate manifest (generated from the passing fixture)

Generated from the executable migration array in
`src/testing/bike-authenticated-routes.integration.spec.ts` on 2026-11-04.
This is the order that applies successfully to the verified deployed export
(`deployed_public_schema.sql`, SHA-256 `0e9cade63433fc9065fd9282b017e3874332701831b917e933c4b3db925e6857`).

| # | Step | SHA-256 |
|---|---|---|
| 1 | `20261104000000_cancellation_debt.sql` | `fb034b5e77a4e0ecad73b5dc7956bdfc047f7bf908692344719736f63d8a4762` |
| 2 | `20261105000000_campaigns_referrals.sql` | `710563b1dad2b323fd9e1518a04404ba2b51b2b2e2b44b54fa7d46a4ebf0af66` |
| 3 | `20261253900000_flutterwave_market_provider_prerequisite.sql` | `c30d20683c5583bdea86922acff761c1b5140f86084e81e689bcadf50c2878de` |
| 4 | `candidate/003_neutral_2a_columns.sql` | `66589d20146cbb517f964c9a381150a683a5755181a01b8cd14479d715467df5` |
| 5 | `20261254100000_wallet_fee_freeze_batch2b.sql` | `5d7bfbe53c71a8d18bbd27370692438a088f47371d1da6a2df6bc31c6b9172ed` |
| 6 | `20261254200000_flutterwave_provider_accept_batch2c.sql` | `bf51e60441246c7f6c0c2e67ceb433b79d493e608ab9c2fe7a8f1f5e4db8cfdc` |
| 7 | `20261254300000_wallet_atomic_confirm_batch2d.sql` | `a68a79ffd1aca016949fe439c303180a1b76c7f1df25dc0166d56e8b2600995a` |
| 8 | `20261254400000_wallet_fee_policy_v2.sql` | `10d00bb1ef66e28944342d60b1b0a83a43e41ba6dcfa798cd4554fa5b5846fc6` |
| 9 | `20261254500000_driver_card_five_percent_policy.sql` | `6fbb64af77059189dedc67bd0e26bc94faf3543b203f0ef02accb3126a2a4883` |
| 10 | `20261255500000_cash_acquisition_eligibility.sql` | `84e6349d75d27c469806ab68f717f6a3bdde34563813616b2c927f773b84e29c` |
| 11 | `20261255600000_cash_disabled_acquisition_gate.sql` | `bacf079d72e55d6c91254e3fb911c9231799e4a6ce918e263a7c12ea62529265` |
| 12 | `20261255700000_commercial_policies_v2.sql` | `68fdd186f09e5476446844c8f6846f334f983f7d1c511c30d9e957b84e95baa5` |
| 13 | `20261257000000_bike_fulfilment_category.sql` | `0149401e998530a34c3b7342f4933c17d3f9e4cb7e794995fdec93460535990c` |
| 14 | `20261259000000_market_bike_limits.sql` | `684bd64e2435f1b87a7580b33b6fc5f490bfd4e4740b4a56b45cb30e59db2be1` |
| 15 | `20261260000000_bike_assignment_trigger.sql` | `06b765e0646d4f10f58a64b6f9f31067b82c2c249666bca941fae866cf57cbda` |
| 16 | `20261261000000_bike_guard_snapshot_authority.sql` | `1806aa2f9878ee3b19a8c06ca3f250d4903a8c9ef2bcfaa67253cbe69da56f77` |
| 17 | `20261262000000_driver_feed_visibility.sql` | `32c9b2f5f84e17439f2d81fd423dc5a4d1a70098fb3725f5a0ce280ea9ff1fcb` |
| 18 | `20261263000000_courier_cash_reassignment.sql` | `a4a205d2681ff4662e83e955002a98fcd0ca62301d3f87bacf28ef6b0bdd65c2` |

## Superseded step (do not apply raw)

`20261254000000_flutterwave_provider_batch2a.sql` — SHA-256
`629ea2827e41d233c983cdc4ade3a8e65cb2268c1e4bac874efeacd3b320b7cc` —
superseded by `candidate/003_neutral_2a_columns.sql` (removal of the 7-line
`NG/NGN/card` Flutterwave route insert only). Existing `NG/NGN/card → Kora`
route and bindings must remain unchanged (asserted in the fixture).

## Dependency notes

- `20261104000000_cancellation_debt.sql` is required by `20261255700000`
  (`customer_receivables`).
- `20261105000000_campaigns_referrals.sql` is required by `20261255700000`
  (`referrals`).
- `20261255500000` / `20261255600000` are required because the deployed
  eligibility trigger rejects `pending`/`cash_due` assignment.
- `20261254500000` adds the sandbox scope and 5% driver-card fee policy used by
  the funded fixture.
