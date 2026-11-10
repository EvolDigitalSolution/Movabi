Verified baseline review, 29 October 2026

Input archive: review-8879bdb792f3.tar.gz
SHA256: 342c495d392092637376d48da9e3d4376de4b34609deb3588d17bd97872b6c23
Exactly four regular members were validated: the three requested sources and
source-manifest.json. All source hashes and the pinned image identity match.

The local entry adds booking-split, Kora and wallet routes, omits the deployed
market-provider lookup, and has unrelated text changes. None are copied. The
release adds one setup mount to the original deployed entry after its existing
global middleware and before its payment mount. It injects the already-loaded
supabaseAdmin. Every other entry byte and route stays as deployed.

The onboarding router receives only two additional server-derived inputs at its
status and submit-review evaluations, plus a private per-app status helper.
Only the confirmed driver's authenticated UUID requires the new payment result.
The setup service independently enforces tenant, role, activated registration,
NG/NGN, TEST merchant configuration and provider binding. Request-body claims
cannot disable the requirement or declare it completed.

The deployed requirement evaluator receives an optional, selected-driver-only
requirement. Its existing age, address, documents, agreement, vehicle, licensing,
review and online rules are retained. The selected driver stops receiving the
irrelevant Stripe warning. GB and other drivers retain their deployed evaluator
outputs; 18 before/after cases compare the entire result. Broader local changes
that made payment setup mandatory for every country are deliberately excluded.
The existing Stripe Connect routes/readiness and booking/payout sources remain
unchanged. Onboarding completion and identity verification are never written by
the setup service; the existing normal review submission remains authoritative.

integration-plan.json pins before and after hashes. The patcher checks all three
inputs before writing anything; unknown or partially patched inputs fail. A
fully identical repeat is verified without writing. Image preparation checks
the six protected files, two absent Stripe modules and the three reviewed
onboarding sources before/after. No expected protected hash was replaced.

Local tests executed the compiled packaged API with real disposable GoTrue,
PostgREST and PostgreSQL, mocked provider transport, the patched onboarding
controller, and pure profile/vehicle/licence models. Unrelated MOT/notification/
market-service boundaries use explicit fixture implementations; these fixtures
do not certify those services or change their deployed implementations. The
normal status and review routes verified payment completion, identity blocking,
forged-input rejection and normal under_review submission. Claims, uncertain
outcomes and recovery retain the previous failure-injection tests.

The local image is explicitly a runtime fixture, not the unavailable pinned
server image. The operator must build from the actual pinned image and execute
its original CMD in a network-none cold smoke test, then run the packaged HTTP
suite, before disabled deployment can proceed. No real provider request,
beneficiary creation, deployment or hosted browser acceptance is claimed here.

Devin owns the separate cash-exclusion files. They are not included, edited or queued for integration here. Setup-only onboarding does not wait for that work. Existing cash-ride, collection and transfer gates remain unchanged and disabled. Genuine merchant evidence and the private TEST binding gate provider activation, independently of image preparation and disabled staging.
