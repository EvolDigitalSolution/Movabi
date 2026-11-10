> Superseding proposed topology and remaining decisions: [co-hosted develop onboarding plan](NG_SUBACCOUNT_COHOSTED_DEVELOP_PLAN.md). The old separate-process database-binding requirement below is superseded for the recommended plan.

> Current follow-up: [first creation through onboarding](NG_SUBACCOUNT_FIRST_ONBOARDING_TEST.md). The empty-list diagnostic has completed; do not rerun it as a setup prerequisite. The earlier image below predates the empty-list fix and must be rebuilt before rollout.

# Accepted rehearsal result, HTTP 400 diagnosis and gated deployment plan

27 October 2026. This records the user's supplied real-server results. No provisioning, real rehearsal, provider request, migration deployment or activation was repeated by the tools in this turn. Stripe and the booking journey are unchanged.

## What is verified

| Evidence | Result | Scope |
|---|---|---|
| `restoreVerified` | true | The real archive restored successfully under the helper's checks |
| `collectionMigrationCloneVerified` | true | The reviewed collection migration set applied inside the isolated restore |
| `selectedExistingDriverVerified` | true | Driver `318e6be9-9164-41fa-bb0c-c5ccd3526585`, tenant `d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8`, matched the source/restore scope |
| `collectionGatesDisabledVerified` | true | Clone setup/collection/payout configuration remained disabled |
| NG bank catalogue and NGN fee quote | accessible | The supplied test key was accepted for these requests |
| Collection subaccount list | HTTP 400 | Recognised empty list: both GET variants returned HTTP 400 / Subaccounts not found |
| Merchant identity, create, settlement and transfer | unverified/untested | No entitlement or settlement conclusion follows from bank/fee access |

Keep the fresh run's existing backup-directory, checksum and verification-manifest reference in the release record. Do not substitute the older historical archive reference. These metadata can be retained without disclosing the archive contents or keys.

## Why `canonicalCloneVerified=false` is expected

`verify-develop-wallet-backup.py` has separate, mutually exclusive paths:

- `--migration-directory`: apply the checked collection migration sources to a fresh restore and set `collectionMigrationCloneVerified`.
- `--validate-canonical-sql`: apply the separate canonical SQL release twice and set `canonicalCloneVerified` and `canonicalRepeatVerified`.

The output uses `manifest.get('canonicalCloneVerified', False)`. In the collection-migration path that field is not set, so it reports false. Here it means **canonical SQL validation was not requested**, not that a canonical validation failed. The four true flags certify the selected rehearsal.

**No extra rehearsal is needed merely to turn this field true.** Repeat only for a changed migration set, changed relevant baseline/scope, or a different release requiring its own canonical validation. The earlier card-wallet canonical bundle is not certified by this collection-only run and is not part of this subaccount deployment. The diagnostic update in this turn changes no SQL; the reviewed migration hashes are unchanged.

## Inspecting the HTTP 400

The original probe made:

```text
GET https://api.flutterwave.com/v3/subaccounts?page=1
Authorization: Bearer [private test key; never printed]
Accept: application/json
No request body; no account_bank/account_number/bank_name filters
```

This is the documented **collection** subaccount endpoint, and `page=1` is a documented pagination value. It is not the different payout-wallet endpoint. Do not add the documentation UI's example bank/account values as filters. [Official list reference](https://developer.flutterwave.com/reference/fetch-all-subaccounts)

The original `HTTPError` handler saved only status and discarded the response body. Therefore the current evidence cannot determine whether the cause is an empty result, request validation, an account/environment policy, or a provider-side issue. HTTP 400 alone does not prove a permissions problem.

The revised `--diagnose-subaccounts` mode compares exactly two GET requests:

```text
/v3/subaccounts
/v3/subaccounts?page=1
```

It reports UTC request time, path, non-sensitive parameters, HTTP status, bounded recognised error codes and **allowlisted/canonicalised** message categories. It never prints arbitrary provider prose, headers, data objects or unrelated subaccount records. A message can echo sensitive input, so unknown prose is withheld rather than relying on an unreliable general-purpose regex scrubber. Numeric error codes are limited to short code-shaped values; unknown code strings are withheld too.

Examples of interpretation, pending actual output:

- Explicit `no_rows` message: evidence of an empty-list response; not permission denial, and still not proof of create permission.
- Unpaged success with paged failure: investigate pagination/backend behaviour. Do not change the production adapter until that difference is confirmed.
- Explicit authentication/access/environment category: follow the reported category and provider logs; distinguish it from missing records.
- Unrecognised/non-JSON/oversized body: use the request timestamp/path/status in Flutterwave's private request logs or support channel. Do not paste raw responses or logs into chat.

Diagnostic exit 0 means it completed its read-only inspection, **not** that access or merchant identity is approved. `capabilityApproved` stays false. It reads the already-provisioned private test file; no key entry, file rewrite, payment or transfer occurs.

### Next operator command

Copy the updated **non-secret** bundle from Windows PowerShell so its checksum manifest stays aligned:

```powershell
scp -r 'C:\Users\fedri\source\repos\Movabi-mobile-develop\scripts\ng-sandbox-review' edsadmin@87.106.64.25:~/
```

Then in the existing SSH shell:

```bash
bash -e <<'SH'
cd "$HOME/ng-sandbox-review"
sha256sum -c SHA256SUMS
python3 check-flutterwave-test-merchant.py --diagnose-subaccounts
SH
```

Do not rerun provisioning or the completed rehearsal. Do not print the credential file. The revised code and Linux tests use synthetic data locally; the real diagnostic result remains pending.

## Merchant reference and account identity

Keep three concepts separate:

1. `FLUTTERWAVE_COLLECTION_MERCHANT_REF` is Vaydu's configured internal alias. A format-valid alias is not a provider identity attestation.
2. Flutterwave's Merchant ID/MID identifies the provider business account. The dashboard displays it under the business name. [Provider guidance](https://developer.flutterwave.com/docs/wallet-to-wallet)
3. A transaction response's `account_id` is a provider field used by payment verification. Do not assume it equals the MID or internal alias without provider evidence.

Without creating a payment or transfer, the owner can establish the mapping privately:

- Open the intended business account and its **test** API-key page; confirm the existing key's origin in that workspace. Do not paste, print, rotate or re-enter the key in this workflow.
- Record the intended MID/business identity and internal alias as a controlled non-secret mapping.
- Correlate the diagnostic UTC times, GET paths and statuses with requests shown in that account's private API logs, if available. If correlation/ownership remains uncertain, obtain Flutterwave confirmation for the intended MID and those requests.
- Record the operator/provider attestation reference before marking merchant identity verified. Bank/fee success alone is insufficient.

The documented merchant-ID account-resolution API can resolve a destination name, but that does not prove the supplied key belongs to the resolved merchant. No such POST is needed for the next diagnostic, and no transfer/payment should be used merely to discover identity. [Resolution documentation](https://developer.flutterwave.com/docs/bank-account-verification-1)

## Supported application connection: still blocked

Available source evidence:

- `server/services/supabase.service.ts` initializes the existing API client from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Both repository Compose files use environment interpolation. No supported secret-manager command/binding was found; the supplied remote audit likewise found none. No `.github` deployment workflow was available in the inspected repository to establish another binding.
- The route constructor accepts the existing `supabaseAdmin` object by dependency injection. That is code-supported **in-process** reuse. It does not provide a connection to a separate process, and does not authorise serialising/extracting that client's credentials.

Under the current isolated-process plan, an operator-supported existing manager binding that directly injects the two values is still required. No verified launcher/binding name exists to put into an executable deployment command. Do not replace it with container Env extraction, a copied credential file, a PostgreSQL admin login or an invented vault command.

A co-hosted setup route could reuse the existing API client in place without copying values, but it changes the reviewed topology and would need a separately reviewed runtime-guard/deployment change: the existing API uses `NODE_ENV=production`, while the sandbox currently requires test/development. That alternative has **not** been selected or implemented in this turn. The current isolation and guards remain intact.

## Exact proposed rollout and single-driver activation

No deployment is authorised by this document. The order and gates are:

1. **Accepted:** retain the completed real rehearsal's manifest/checksum and the unchanged collection migration-manifest hash. Do not rerun it solely because the canonical flag is false.
2. Accepted: both list variants returned the recognised no_rows response. Verify the intended test merchant mapping. A resolved empty-list response still leaves create permission to be tested once through the authenticated driver flow.
3. Establish the supported connection injection for the isolated process, or review/select the in-process alternative before writing an actual launcher. This remains a hard application-start blocker.
4. After a separate deployment instruction, apply the exact already-rehearsed disabled files, in order: `20261253900000`, `20261254600000`, `20261254700000`, `20261254800000`, `20261254900000` (full filenames and hashes are in `scripts/ng-sandbox-review/migrations/migration-manifest.json`). Preserve existing route history/approvals and report any preserved deliberate Kora override. No blanket provider/market activation.
5. Use the reviewed isolated image `vaydu-driver-collection-sandbox:review-20261027`, ID `sha256:40c4a6cc0372b156dc00c4a64091f6aa58af38e799d3b144ff3a1672e8e159a9`, through the verified develop deployment mechanism. Preserve the shared API/Stripe environment. Inject the existing provider file by reference and the connection only through the approved mechanism. Neither is baked into an image or copied into the repository.
6. Limit develop ingress to the account setup endpoints `/api/driver-payment-account/{status,banks,resolve,setup,reconcile}`. Do not expose/activate the new booking checkout flow. Keep existing Stripe `/api/connect` routing intact.
7. Only after review, configure the **one** NG/NGN `driver_collection_markets` row with the confirmed driver/tenant, test environment, verified merchant alias/evidence reference, approved administrative default, `setup_approved=true`, `adapter_ready=true`. Keep all other market setup approvals false.
8. The administrative default proposal remains **flat 0, not yet approved**. It is not the 5% wallet fee or a booking commission and is not an intrinsically harmless fallback. All future eligible booking payments must override it with the frozen driver amount and verify the actual allocation. No booking payment is submitted in this setup test. Stop if this merchant rejects the proposed default; do not silently change it or repeat an uncertain create.
9. Future setup-only runtime flags: `NODE_ENV=test`, `VAYDU_DEPLOYMENT_ENV=develop`, `VAYDU_DRIVER_SUBACCOUNT_SANDBOX=true`. Keep `VAYDU_DRIVER_TOPUP_API=false`, `VAYDU_DRIVER_PAYOUT_SANDBOX=false`, `VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX=false`, `VAYDU_BOOKING_SPLIT_TIMING_APPROVED=false`; live Flutterwave key empty. Keep database `split_collection_approved`, split/fee/settlement verification approvals and F4B approval false. Do not change the current customer booking journey or Stripe capture/payout rules.
10. Sign in as the confirmed driver, open Payment account, privately enter approved sandbox bank/contact data, resolve and confirm the account name, and submit once. Require a matching provider subaccount retrieval and private driver/tenant/NG/NGN/test association. Report only state, association/retrieval match and any safe provider error category—no bank details or raw payload.
11. Reload/reconcile: the same operation/reference must be returned with no second create. Test wrong-owner isolation. A timeout/ambiguous response remains reconciliation-only. Verify that no checkout, transfer, live capability or paid-work journey was enabled by setup completion.

Rollback disables only selected setup, stops the new isolated service and removes only its develop proxy/frontend override. Retain subaccount references and uncertain-operation history; do not delete/recreate them or rotate the existing private key/HMAC as a workaround.

## Changes and validation in this turn

- Added a safe two-variant subaccount diagnostic; the original probe's meaning and the supplied real evidence are retained.
- Tested synthetic HTTP 400/no-rows, authentication/page messages, malicious key/account/name echoes, unknown/non-JSON/oversized bodies, successful lists without record disclosure, and live-key rejection before any network call.
- Tests passed locally on Windows and in network-disabled Linux. Bundle checksums were regenerated for the diagnostic; SQL sources, application code, booking journey, provider credentials and database connection were not changed.
- The actual HTTP 400 is now identified as the recognised empty-list response. Merchant identity/create entitlement and supported external connection injection remain unresolved. No actual creation, settlement or transfer was tested.
