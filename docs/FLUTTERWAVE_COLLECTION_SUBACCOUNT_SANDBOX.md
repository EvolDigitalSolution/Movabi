# Flutterwave collection subaccount correction — 27 October 2026

Implemented and tested locally. Nothing was deployed, no real key was entered into the tools, no provider request was made, and no live or provider-sandbox payment/transfer was initiated. All API fixtures and terminal inputs used in tests are synthetic. Existing Stripe GB behavior and the approved card wallet top-up policy are retained.

## Three different products

| Product | Purpose | What creation does not establish |
|---|---|---|
| Collection subaccount (`/v3/subaccounts`, `RS_…`) | Destination/allocation for an incoming payment split and subsequent settlement | A transfer beneficiary, virtual receiving account, bank payout completion or Connect-style readiness |
| Beneficiary plus Transfers API | Saved destination followed by a separately initiated disbursement | Participation in a customer collection split |
| Virtual account | Receiving bank transfers through an issued account number | Automatic collection splitting or a completed driver payout |

The corrected driver-facing **Payment account / Set up payment account** flow now uses the first product. The earlier beneficiary implementation remains an explicitly separate transfer adapter; its records are neither relabelled nor migrated into collection subaccounts. See the official [collection API](https://developer.flutterwave.com/reference/create-a-sub-account), [split guide](https://developer.flutterwave.com/docs/split-payments), [beneficiary API](https://developer.flutterwave.com/reference/create-a-beneficiary) and [virtual-account guide](https://developer.flutterwave.com/docs/virtual-account).

## Setup implementation

- Authenticated driver/tenant/registered market comes from the server, never a submitted driver ID. NG/NGN is the installed sandbox implementation. GB delegates to existing Stripe onboarding. African planning preferences do not approve merchant capabilities.
- Form collects required business/account name, contact email/phone and bank details, resolves the destination, and requires confirmation. A Flutterwave Merchant ID option appears only when that account type has its own merchant approval; it uses the documented `is_f4b_account` shape. No virtual account or hosted onboarding is invented.
- Separate `driver_collection_markets` configuration and `driver_collection_subaccounts` records. Setup approval, F4B approval and booking split approval are distinct from existing transfer/collection gates. All new approvals default false. The administrative default split required by the API is server-owned and deliberately unset until approved; booking commission is never inferred from that default.
- A permanent unique setup claim commits **before** POST. It freezes the driver, tenant, NG/NGN, test environment, merchant alias, destination HMAC, request HMAC, last four digits and administrative split terms. Names, contact data, account numbers and raw provider payloads are not persisted in the new tables or returned in account lists.
- Creation includes a random operation marker and keyed request marker in supported `meta`. Verification uses the documented paginated **list collection subaccounts** endpoint, checks the persisted markers/destination/terms and associates the returned numeric ID and `RS_…` ID privately. No undocumented GET-one endpoint is assumed.
- Status means **retrieved and matched**, not an invented active/charges-enabled/payouts-enabled flag. Merchant capability evidence remains separately required. Existing registration/work eligibility is not replaced by account setup.
- Invalid local details or a changed resolved name cannot acquire a create claim. Concurrent requests get one POST. Once claimed, failures/timeouts become reconciliation-only, even if a later list is empty. The UI offers **Check setup status** instead of another create. Missing markers, ambiguous matches, an existing unrelated bank subaccount, or an unsupported response shape require review; they are not silently attached or recreated.
- Full account numbers are transient in the confirmed form and provider requests. Errors are sanitized, API responses are owner-bound and uncached, and the provider key must be test-mode before the network boundary.

## Booking authority and payment timing

Inspection found that existing Stripe booking checkout authorizes before a driver may be assigned; it uses manual capture at completion. The established `FareSplitService` snapshot supplies customer charge, platform fee, driver commission, driver entitlement and any subscription commission waiver. Completion/earnings are owned by the existing settlement writer and job payout outbox.

The new split adapter uses those frozen amounts, exact NGN minor units and conservation checks. It supplies an explicit per-transaction **flat driver allocation** (`flat_subaccount`) rather than a new percentage. Vaydu gross is the frozen platform fee plus commission; provider deductions remain separate. Preflight checks the actual estimated customer total and reviewed fee reserve. No wallet top-up fee is applied to booking earnings.

The split guide contains inconsistent prose about flat/default semantics; the implementation follows its transaction-override example, but **actual test-merchant validation is mandatory** before `split_semantics_verified` can be approved. The provider also warns that deductions can prevent a flat allocation. The code therefore requires a reviewed amount cap and deduction budget, and never assumes the wallet's 5% covers provider costs. [Provider split rules](https://developer.flutterwave.com/docs/split-payments)

Eligible split collection is deliberately narrow: a completed NG/NGN card booking, assigned approved driver/subaccount, exact tenant/currency, explicit `metadata.driver_settlement_method='split'`, frozen conserving fare, and no existing Stripe intent, transfer, refund or no-show. Wallet/cash payments, errands with purchasing budgets, early collection, unassigned drivers and changed fares are rejected. Every outbound booking request also requires the separate timing/collection runtime approvals, which remain off.

**Timing decision still needed:** approve a customer checkout at completion, after driver and final fare are known, or approve another separately designed lifecycle. The normal booking workflow currently does not produce a completed/unpaid Flutterwave checkout step. The adapter, authenticated quote/checkout/verify/settlement endpoints and RPCs are prepared; this change does **not** silently rewrite completion/dispatch into a new customer payment journey. Existing Stripe manual capture is unchanged. The `/booking-payment-return` page is implemented locally: it treats callback parameters only as a booking identifier and requires an authenticated server verification before showing payment success. Callback routing and the full customer checkout-at-completion journey still require approval; neither is deployed.

## Exactly one driver settlement

`job_settlement_methods` has one row per job. Existing outbox entries are backfilled as **transfer**. A new split reserves its method and frozen terms before provider submission; an atomic second claim permits one checkout POST. Timeouts keep the same reference and are lookup-only. The transfer outbox cannot accept a split-owned job. New NG transfer bookings must explicitly select **transfer**; subaccount setup never causes an automatic transfer or fallback.

Collection success records pending earnings, not paid earnings. Server verification checks the merchant account identity, reference, card method, currency and both requested/charged amounts. A separate settlement query requires a completed subaccount-filtered batch with the matching transaction and exact driver allocation. Ambiguous/paginated or insufficient evidence remains pending. Zero allocation never triggers a transfer fallback. Settlement reuses `record_job_settlement` and the existing unique earnings row. Sanitized collection fee and settlement/duty observations are stored privately for comparison.

An isolated polling worker can reconcile submitted/collected bookings without a browser return. It performs lookups only; it cannot create another checkout or change methods. Both collection and timing gates must be explicitly approved before it runs. The old transfer reconciler is behind its own separate gate.

The public settlement example includes `subaccount_settlement`, but the amount/attribution and filtered payload shape must be confirmed on this merchant before automated settlement is approved. Successful collection alone is insufficient, and no fixed settlement day is promised. [Settlement documentation](https://developer.flutterwave.com/docs/settlements)

## Cancellations, refunds and fare changes

- Fare, driver, tenant, currency and settlement-method changes are blocked once split terms are reserved. Normalizing legacy price columns to the same frozen total is allowed; changing the entitlement is not.
- Cancellation before submit marks the reservation cancelled and prevents collection. Cancellation after submit/collection enters refund review, blocks settlement credit and retains the original reference.
- Generic Stripe refund/reversal paths cannot operate on split-owned jobs. No-show charging cannot be substituted for a reserved split.
- Automatic split refunds, allocation reversals, chargeback liability and post-settlement recovery are **not enabled**. They require verified merchant procedures and an explicit product/accounting decision. Existing Stripe refund behavior for Stripe-owned bookings remains unchanged.

## SQL and deployment status

New reviewable migrations, not applied remotely:

- `20261254800000_flutterwave_collection_subaccounts.sql`: independent collection setup/configuration, immutable creation claims, private association, settlement-method lock and cancellation/refund/fare guards.
- `20261254900000_flutterwave_booking_split_authority.sql`: frozen-fare reservation, one collection submission, verified collection/pending earnings, sanitized observations and verified settlement through the existing earnings writer.

They follow the earlier provider/payout prerequisites. No prior applied migration was rewritten. Fresh develop catalogue inspection and a rehearsal against the retained real backup remain prerequisites; current SQL tests use a disposable minimal schema with the actual existing outbox/settlement functions, not the real develop archive. The old card-only pinned deployment bundle is not a release bundle for this feature.

`server/Dockerfile.driver-collection-sandbox` prepares the isolated runtime. Its image has not been built or deployed in this task. `scripts/inspect-driver-payment-account-develop.sh` now reports the new table/gate presence and aggregate setup states without bank details. No claim is made that the new migrations are already present on develop.

## Secret-manager inspection and private test-key entry

Local `docker-compose.yml` uses environment interpolation. The available deployment template has no secret-manager command marker or Docker secrets declaration. Prepared sandbox Compose references `VAYDU_DRIVER_CARD_CONNECTION_ENV` and `VAYDU_DRIVER_CARD_PROVIDER_ENV`, but these are **unresolved placeholders**, not discovered bindings. No supported binding was found in the available configuration. Remote supported mechanisms remain unverified because execution tools do not have the authenticated SSH connection.

`scripts/inspect-vaydu-secret-bindings.sh` is a read-only inventory for the existing SSH shell. It reads only the develop API's Compose labels and referenced YAML, and prints binding names/manager markers. It never reads container environment values or secret-file contents. An `env_file` alone does not establish a secret manager; external deployment tooling may still need operator identification.

`scripts/provision_flutterwave_subaccount_test.py` is the reviewable fallback requested by the user. Copy this non-secret script to the authenticated SSH host and run:

```sh
python3 provision_flutterwave_subaccount_test.py
```

It reads the **TEST** key and merchant reference using hidden `/dev/tty` prompts, rejects live-key format before any network action, and makes **no provider request**. It creates a fresh private file outside Git at `~/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env` with directory mode 0700/file mode 0600; it refuses overwrite/symlink targets. A random stable HMAC key is generated privately. The live key is empty and setup/collection/timing flags remain false. Only the file reference is reported; do not print its contents or put key values into shell commands/history.

The script has **no database credential input, extraction or copying logic**. The develop database connection remains unconfigured. What is needed is an operator-identified supported existing manager injection for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; an invented copied credential file is not an acceptable substitute. The new runtime requires the previously verified develop target. Actual test-key/account capability confirmation remains pending private entry and approved connection injection.

## Remaining merchant checks and decisions

Already decided: first sandbox market NG/NGN, intended provider Flutterwave, and the separate shared card top-up fee of 5% of wallet credit. These were not requested again or used as booking commission.

Still required:

1. Approved NG driver and tenant. The last supplied inventory had only an activated GB/GBP driver; no Nigerian customer is reused.
2. Test merchant reference/account identity and actual v3 collection-subaccount entitlement, supported destination type, NGN/card support and metadata/list behavior. F4B requires separate proof.
3. Approved administrative subaccount default. No production percentage/value is hardcoded; every booking will override it from frozen earnings.
4. Payment timing/completion/customer-return workflow decision described above. Transfer selection must be explicit where split collection is unsuitable.
5. Actual split allocation, fee passing, VAT/duty/other deductions, settlement schedule/payload, refund/reversal and chargeback behavior on this test merchant. Public documentation does not prove these account settings.
6. Supported connection injection, fresh remote catalogue/backup rehearsal, and a separate explicit instruction before deployment, enablement or a real transfer. No live payment capability was enabled by this work.

## Actual local validation

- Server TypeScript compilation passed.
- Develop mobile build passed with the existing `src/app/app.css` budget warning (113.81 kB versus 100 kB).
- Complete relevant Vitest suite: **360 tests passed across 17 files** (including existing Stripe onboarding/earnings/payouts, Connect coalescing, prior transfer adapter and 5% card wallet regressions).
- Five Chromium scenarios passed: successful collection-subaccount setup/reload, uncertain creation followed by reconciliation without repeated submit, Flutterwave wallet top-up handoff Stripe wallet top-up handoff, and a booking return whose query-string success cannot replace server verification.
- Disposable PostgreSQL checks passed: unique concurrent setup/collection claims, private grants, isolated environment/driver/customer, frozen split conservation, cancellation/refund/no-show/fare guards, single split earnings credit, no transfer queue for split-owned jobs, and unchanged original Stripe SQL completion.
- Linux PTY test passed: hidden synthetic inputs, live-key rejection, private file permissions, gates off, no DB credential fields and no network requests. No actual user key was provisioned by the tools.

Primary API references also checked: [create collection subaccount](https://developer.flutterwave.com/reference/create-a-sub-account), [list collection subaccounts and pagination](https://developer.flutterwave.com/reference/fetch-all-subaccounts), [bank resolution](https://developer.flutterwave.com/docs/bank-account-verification-1), [settlement detail endpoint](https://developer.flutterwave.com/reference/get-a-settlement).
