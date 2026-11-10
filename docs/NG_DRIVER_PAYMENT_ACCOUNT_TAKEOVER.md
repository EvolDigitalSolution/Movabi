Update after verified baseline review, 29 October 2026

The archive 342c495d392092637376d48da9e3d4376de4b34609deb3588d17bd97872b6c23 was validated: exactly the three requested sources plus source-manifest.json, all hashes matching. The release now patches those deployed files directly and preserves the market-provider lookup omitted by the local entry. It does not copy the local full entry, broad collection routes or all-market requirement changes. Only the approved driver receives the new mandatory requirement; deployed GB and other-driver results remain unchanged in 18 complete before/after comparisons.

Reviewed API bundle: deploy/vaydu-payment-account-api-20261029-r1.tar.gz
SHA256: 154716be4e48e848a42225d7c9f677b3e00c62d4ed4a801673ea12ff2ad077a4
Its BASELINE_REVIEW.md and RUNBOOK.md supersede the earlier draft instructions below. Forty-six regular members were verified, including exactly seven API files and no cash-exclusion files. The extracted published bundle passed the container-based real Auth/PostgREST/PostgreSQL HTTP suite, including normal patched onboarding status/review submission and forged-input rejection. Identity still blocked before normal submission; normal success remained under_review and did not mark identity verified. Fresh focused regressions: 163 passed; server type-check passed; operator guard tests: eight passed.

The image build/patch and original-CMD cold smoke were exercised on an explicitly local runtime fixture, not the unavailable pinned server image. The operator must run prepare-image and test-api against the actual pinned image before staging. Actual real-backup rehearsal, disabled deployment and hosted/provider acceptance remain unperformed. The guarded sequence is fully documented in the bundle.

The user is Devin's coordination bridge. Devin owns only his dedicated cash-exclusion migration/tests; no such file was included or edited. The integration owner will review the exact allowlist, baseline and task-specific diff when supplied. Activation stays blocked by cashExclusionReviewed=false. Merchant approval is accepted only through explicit private operator dashboard evidence and a matching private TEST binding, never from the alias or endpoint access. No new credentials were requested, provisioned, extracted or printed.

The following text is the earlier working-state record, retained as history.

---

Vaydu NG payment-account takeover — 29 October 2026

This is a working implementation record, not a deployment approval or a ready
release. Do not run the old 20261028 archive. No replacement deployment archive
has been published. The working release explicitly leaves
`onboardingIntegrationReviewed=false` and `setupEvidenceApproved=false`.
Do not change these booleans or expected protected hashes to bypass review.

The approved scope remains Flutterwave TEST / NG / NGN, driver
318e6be9-9164-41fa-bb0c-c5ccd3526585, tenant
d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8. Setup creates a transfer beneficiary
destination through onboarding; it does not initiate a transfer. No collection
subaccount, split, booking payment or wallet credit is part of this release.

The new setup-only service takes its database and provider factory explicitly.
The compiled payload contains exactly seven files: mount, private-file runtime,
onboarding router/service, beneficiary adapter, and its existing arithmetic and
contract dependencies. The process-global Supabase stub and copied Stripe
services/bridge have been removed from that payload. Each Express app owns its
setup-service bridge through app.locals. Existing supabaseAdmin is reused in
process; no database credentials are extracted or copied.

The private-file runtime accepts production NODE_ENV with a separate explicit
develop setup opt-in. It validates the existing in-process develop Supabase URL,
TEST key format, private-file permissions, configured internal merchant alias,
and disabled money-movement flags. Its beneficiary client unconditionally has
transfers disabled. The alias is not a provider-issued Merchant ID or account
identity proof. Pure destination setup does not use wallet transaction
account_id, checkout returns, collection webhook secrets or split defaults.
No actual private server file was read during the local tests.

The Angular payment-account form now selects a bank, resolves the account,
requires explicit confirmation, and shows verified destination status. It no
longer asks for collection-subaccount contact fields or consent to booking
splits. A completed setup refreshes the existing canonical onboarding status.
The role guard retains mandatory onboarding; there is no dashboard exception.

The local requirement evaluator previously treated GB payment setup as an
optional warning. The latest instruction makes payment-account setup mandatory.
It now requires a server-verified available completed result from Stripe for GB
or Flutterwave for NG. GB's existing PayoutEligibilityService verifies the actual
Stripe charges/payouts flags; the Connect, booking and payout sources are not
changed or copied into the payload. A local `connected` mirror cannot substitute
for that verification. Identity, documents, age, compliance and review remain
separate requirements. Other capability and profile flags are not completed by
destination setup. Normal submission remains the existing authenticated
submit-review workflow, rather than a manual SQL onboarding flag update.

The existing setup canonical SQL has not been rewritten. Its original file
hash is 986fed074d5c368085f8cfe9bf3bddc3a16393eb3b9058d3afdf0f9db94564f9.
The prior release.json expected a different hash even before this takeover;
the draft metadata now describes the unchanged file correctly. The additive
payment_account_recovery_v2.sql follows that canonical installation. It adds a
durable pre-POST fence, immutable submitted terms and candidate identifier, and
an operator-only recovery-candidate binding. It does not replace an installed
claim function or alter routing, booking, settlement or outbox authority.

Creation is fenced immediately before the beneficiary POST, after resolve/name
checks. A saved candidate is verified with GET before completion. Completed
replays do not create again. An expired unsubmitted lease can be reclaimed;
a submitted or uncertain attempt cannot. A persisted candidate can recover
through the owner-authenticated reconcile route, which uses GET only. If a
provider success preceded candidate persistence, support must obtain and review
the provider candidate identifier, then call the private owner-only
bind_driver_payment_recovery function. Binding records an evidence reference
and leaves reconciliation_required; it never completes setup. The driver must
still reconcile and pass the provider ID/bank/fingerprint check. No method
automatically clears submission intent or repeats creation after ambiguity.
If a candidate cannot be established, the attempt remains blocked for support.

The documented provider operations are POST /v3/beneficiaries and GET
/v3/beneficiaries/{id}. The latter returns the beneficiary identifier, bank code
and account number needed for the private verification. Provider references:
https://developer.flutterwave.com/reference/create-a-beneficiary
https://developer.flutterwave.com/reference/fetch-a-beneficiary
https://developer.flutterwave.com/reference/list-all-beneficiaries
No actual merchant capability or beneficiary creation is claimed from these
documents or from mocked provider responses.

Executed local verification:

- 163 tests passed across the beneficiary/payment requirements, onboarding
  stages, post-payment convergence and deployed Stripe/payout regression suites.
  Document/vehicle fixtures explicitly supply independent payment verification;
  a pending Stripe account is tested as a mandatory submission blocker.
- Real disposable GoTrue 2.132.3, PostgREST 10.1.2 and PostgreSQL 15 exercised
  the compiled packaged mount/router/service/adapter over HTTP. Only provider
  transport was mocked. This covered invalid authentication, customer denial,
  foreign driver and same-driver/foreign-tenant denial, disabled setup, banks,
  resolution, confirmation, concurrent claims, stale workers, completed replay,
  provider success before persistence failure, failed verification, timeout,
  persisted-candidate recovery and operator-bound recovery. Four creation POSTs
  occurred across isolated synthetic cases; none contacted Flutterwave.
- Initial and partial v1/v2 schema installation, repeat refusal, private
  permissions and claim/recovery behaviour were exercised. The same additional
  SQL assertions are packaged for a disposable restored backup. They require
  data_directory=/tmp/vaydu-restore and roll back every mutation.
- The Linux private-file runtime test passed with synthetic credentials,
  NODE_ENV=production, default-disabled setup, instance isolation and denied
  transfer capability.
- Six offline operator tests passed for schema classification, matching/fresh
  receipts, activation refusal, ordered Compose chains, rollback and manifest
  completeness. Three read-only source-reader tests passed.
- A temporary archive was extracted and its complete seven-file API manifest
  verified. Changed files and unlisted files were rejected. It remained a gated
  draft and was destroyed after testing, not published for deployment.
- Server TypeScript checking passed. The actual Angular develop mobile build
  passed; its existing app.css budget warning remains.
- Four actual Angular browser-fixture tests passed for settings and onboarding,
  explicit confirmation, reload and timeout reconciliation. These do not prove
  the approved driver's hosted session or real merchant acceptance.

The operator's prepare-image/build path now checks the pinned local image,
tags that exact image for BuildKit, guards the six reviewed protected hashes
and two absent Stripe modules before and after build, preserves private build
diagnostics, and writes matching receipts only after container execution.
Its test-api stage launches the real disposable Auth/PostgREST/PostgreSQL test
stack and loads the closure from the candidate image, not a substitute source
tree. This stage has not yet been executed against the actual pinned image,
because sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa
is unavailable on the local Docker host.

The operator also checks exact manifest completeness and the seven-file
allowlist, restores ownership/ACLs using structural NOLOGIN roles only in the
isolated clone, checks pg_restore failure, retains fresh private backups,
compares full protected rows/functions/ACLs/triggers, and checks clone claim
assertions. Compose uses every recorded override in order and refuses an
unrecognized changed chain. Rollback disables the approved setup row and
restores the recorded original API image and original Compose configuration;
it retains additive schema and setup history. These operator guard and rollback
paths were tested offline. No real-server restore, deployment or rollback was
performed during this takeover. Unrelated Stripe queue activity is not required
to stop for account setup.

Remaining external dependency before a release can be finished:
the exact pinned baseline's server/index.ts,
server/routes/driver-onboarding.routes.ts and
server/services/driver-requirement.service.ts must be compared. The narrow
inspect-payment-account-baseline.py helper exports only these three files into
an owner-private archive, with project/image checks and sanitized diagnostics.
It reads no environment files, database credentials, database rows or bank
details. It preserves successful and partial evidence under unique paths.
The already-reviewed six protected files are not exported again.

That review determines the minimal entry and requirement patch and its cold
startup/API proof, rather than assuming current local onboarding sources match
the deployed image. The existing private TEST binding and genuine merchant
setup evidence must then pass their separate server-side checks. Bank catalogue
access and an internal alias are not merchant identity evidence. Automatic
approval review rejected a label-only activation proposal; activation stays
blocked instead of converting an arbitrary evidence label into approval.

The hosted Angular update, actual pinned-image test-api run, real restored-backup
rehearsal, disabled staging, single-driver activation and authenticated browser
acceptance are still unverified. No deployment or provider operation is claimed.
