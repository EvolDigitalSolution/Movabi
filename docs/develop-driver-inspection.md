# Driver inspection on develop

This change is based on develop commit `c11bd5b`. Apply the API, Mobile and Admin changes as a unit with the two inspection migrations, in an isolated develop test environment first. Do not use the earlier v2.3 inspection patch with this branch.

## Test setup

- Verify the test database has the profile and vehicle columns from the existing schema reconciliation. In particular, the driver owns their vehicle through `vehicles.user_id`.
- Apply `20261265000000_driver_submission_authority.sql`, then `20261265100000_driver_inspection_photos.sql`. Both assume Supabase roles and Storage already exist. Use a coordinated rollout: the submission guard blocks the old Mobile client's direct transition.
- Using a trusted operator account, assign a test driver to a test tenant and set `profiles.inspection_market_code` to their authorised market (for example `GB`). Assign a same-tenant admin and a different-tenant admin. Use existing, authorised identities; the migration deliberately does not assign tenants or markets automatically. The client's country preference does not determine inspection requirements.
- Install using `npm ci --legacy-peer-deps`. The API requires Sharp with platform-specific optional dependencies included. Run `npx --no-install tsc -p server --noEmit`, `npm run build:mobile`, and `npm run build:admin`.
- Run `npx --no-install vitest run src/testing/driver-inspection-selection.spec.ts src/testing/driver-inspection-routes.spec.ts`. The HTTP tests run against the real Express router with a mocked Supabase boundary; they do not prove hosted storage or login.

## Signed-in acceptance

1. With a test GB driver, compare Car + Ride, Bike + Errand/Delivery, Car + Ride again, and Bike → Van. Check before saving and after reload. Ride licensing only applies to eligible Ride selections; GB Van Moving shows goods-in-transit cover. Changing the Bike subtype should refresh the checklist; motor subtypes require registration.
2. Save the vehicle from Driver Setup. Upload one image and check that Admin → Driver details shows the correct vehicle, slot and pending state. Open its image and review it with the same-tenant admin. Confirm a different-tenant admin cannot get a signed link or review the photo.
3. Leave one applicable document or photo approval missing. Confirm submission names the item and the profile does not enter review. Complete the applicable requirements and confirm the API accepts submission.
4. Replace an approved photo and confirm only that slot needs a new review. Change the vehicle identity or subtype and confirm the earlier photo set no longer counts. Confirm old files are retained and are not presented as current evidence.
