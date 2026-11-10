# International driver document wording — patch 1

Uses the existing onboarding form, upload categories and review flow.

- Replaces UK-only council wording with issuing/licensing authority, taxi/private-hire permit and driver authorisation wording.
- Uses driving licence, passenger transport insurance and work eligibility document labels.
- Adds a route from driver settings to the existing complete setup form.
- Existing canonical fields, server requirements, expiry validation, eligibility, approval and stored uploads are retained.

This is a presentation and navigation patch. It does not approve any new country or establish country-specific licensing requirements. Existing badge/authorisation requirements remain mandatory wherever the current server requires them. Local equivalents require support review; no invented document references should be entered.

## Validation

Run existing driver onboarding, licence and persistence tests, then both development builds. No new tests are added for copy-only changes.

## Remaining requested work

Emergency early ending needs authenticated two-party confirmation, route evidence, a frozen revised fare, dispute handling and an explicit settlement transition. SOS must remain usable without mutual agreement.

Saved cards already have Stripe collection-time saving, listing, removal and checkout reuse. Standalone card registration needs a provider-hosted setup flow and server ownership/market checks. Kora/Fincra tokenisation support has not been established by this patch.

Driver rating submission exists; ranking must use verified review counts and preserve eligibility, proximity and new-driver opportunities.

Support automation must use approved answers and existing ticket escalation, without inventing booking state or resolving disputes automatically.
