# GB vehicle and MOT lookup

The DVSA adapter uses https://history.mot.api.gov.uk/v1/trade/vehicles/registration/{registration}.
Provider documentation: https://documentation.history.mot.api.gov.uk/.

## Runtime configuration

Add these to the API runtime environment using the credentials supplied by DVSA:

```
DVSA_MOT_ENABLED=true
DVSA_MOT_CLIENT_ID=<DVSA client ID>
DVSA_MOT_CLIENT_SECRET=<DVSA client secret>
DVSA_MOT_TOKEN_URL=<full Microsoft Entra token URL supplied by DVSA>
DVSA_MOT_SCOPE=<scope supplied by DVSA>
DVSA_MOT_API_KEY=<DVSA API key>
```

Keep credentials on the API server, never in Angular environment files or source control.
Until DVSA grants credentials, leave DVSA_MOT_ENABLED=false or omit it. Manual onboarding remains available.
Separate develop/live runtime environments hold their own credentials. This is not a Stripe test helper.
OAuth tokens are cached until shortly before expiry. Requests time out and do not automatically retry mutations.
The lookup endpoint is authenticated and rate limited. Country comes from the stored driver profile, not the request body.

## Behaviour

Only GB onboarding with the backend switch enabled and a non-bicycle vehicle displays the plate-first form.
The API fills make, model, primary colour, manufacture year and MOT expiry when returned.
Year is derived only from manufactureDate, never inferred from first registration.
Fields absent from the response remain manual. Editing the plate requires another lookup before saving.
The save endpoint rechecks the vehicle independently and replaces supplied returned fields with provider values.
Review submission also rechecks MOT and whether saved make/model still match the registration.
Expired MOTs and latest dangerous failures block vehicle saving and submission while lookup is enabled.
Missing MOT history is labelled unknown, not valid or exempt; it requires the existing manual review process.
An MOT does not prove ownership, insurance, road tax, private-hire licensing or current mechanical condition.
Insurance, driver licence and service-specific requirements continue to apply. Lookup never approves a driver automatically.
The server records the lookup snapshot and expiry in driver_requirement_audit (vehicle_mot_checked).
Apply 20261242500000_gb_mot_monitor.sql before deploying the monitoring API.
The server checks GB cars nightly from 02:30 Europe/London, with daylight saving and restart catch-up.
A database lease coordinates replicas; failures retry after two hours. Successful checks for that UK day are skipped.
Expired, dangerous or unknown evidence blocks going online, new assignments and negotiation claims at the database boundary.
Stored expiry blocks new work after midnight even during a provider outage. Existing jobs and payouts are preserved.
Confirmed invalid checks set online/available false. API errors never clear restrictions or manufacture validity.
Existing cars enter enforcement on their first successful check; no evidence is not a fleet-wide automatic ban.
Recheck the existing plate using Find vehicle & MOT details after renewal. A valid result clears only the MOT restriction and never puts the driver online automatically.
Motorcycles/bicycles and other countries retain their current implementation. Unknown history requires support review; no automatic exemption is inferred.
Monitor [GbMot] failures and daily gb_mot_night_runs completion. For large fleets, monitor runtime against the two-hour lease and move to a queued worker before exceeding it.
Verify migration triggers on develop before rollout; SQL integration checks are required in addition to mocked unit tests.

## Verification

Run server TypeScript, gb-mot.spec.ts, driver-vehicle-persistence.spec.ts,
driver-requirement-matrix.spec.ts, driver-requirements.spec.ts and the mobile develop build.
After configuration, test a genuine GB registration and an expired MOT, a missing vehicle, an API outage,
changing the plate during lookup, and switching to a non-GB onboarding country.
No real lookup can be verified until credentials are installed. Do not mark rollout verified from mock tests alone.
