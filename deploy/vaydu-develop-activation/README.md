# Develop GB activation of the approved policy values (2026-11-14)

**Approval:** the user approved all proposals on 2026-11-14 ("Approve all proposals"). The user's standing
instruction authorises activation on develop. This is DEVELOP only and GB/GBP only. Production is untouched,
and Africa providers stay deferred.

## What each script switches on

| Script | Feature | Values |
|---|---|---|
| `activate-gb.sql` | 6a cancellation fee (+6b 80/20, 6c debt threshold) | Fee £3.00, cap £3.00, grace 120 s after acceptance, 80% to the driver on collection, debt threshold 50% of the GB ride minimum fare (read live from `pricing_config`) |
| | 7a first-booking promo | 5%, max £5.00, minimum fare £8.00, budget £500, one per customer, rides |
| | 7b referrals | 5%, reward cap £5.00, qualifying fare £8.00, budget £500. Approved defaults apply: customer credit 90 days and ≤5/month; drivers 20 jobs in 30 days, ≤3/month, 7-day review |
| | 3 PIN default | GB: required for all services (today's behaviour, now explicit) |
| `activate-gb-cash.sql` | 5b cash rides | GB/GBP only, one test driver, terms `fare-split-v1` |

**P13** (fee above the cash hold) stays as manual review, which is current behaviour, so nothing changes.
**P9** keeps the current map style, so nothing changes.

Each script is one transaction and can be re-run safely. It **stops** if:
- it is not run on `movabi_develop`;
- release 2 is missing (referrals would pay wrong amounts);
- the GB ride minimum fare is not exactly one positive value;
- for cash: the email is not exactly one GB driver, or the GB fee policy is not active.

**Needed first:** release 2 (database) and the API from bundle `<SHA>` or later, which carries the promo and
referral minor-unit fixes. Without that API, promo discounts would be 100 times too small.

## Host steps (after the release-2 deploy; read-only checks around them)

```
B=~/<bundle-dir>
(cd "$B" && bash host-live-config.sh) > live-config-before-activation.txt 2>&1
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -P pager=off' < "$B/activation/activate-gb.sql"
```

**Expected:**
- one GB cancellation policy per GB tenant: `300/300/120`;
- `FIRST5GB` and `REFERGB`, GB/GBP;
- PIN `{"markets":{"GB":"required"}}`;
- `non-GB rows enabled (must be 0) | 0`.

**Cash rides** (one GB test driver whose email you choose):

```
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -P pager=off -v driver_email="GB_TEST_DRIVER_EMAIL"' < "$B/activation/activate-gb-cash.sql"
```

**Expected:** only `GB | GBP | t`.

Then set `VAYDU_CASH_RIDE_BOOKING=true` in the API's compose override and recreate the API:

```
API_TAG=release-<SHA> WEB_TAG=release-<SHA>-linux bash rollout-develop-52097ef.sh --deploy-api-only
```

The rollout keeps the overrides and runs release 2's VERIFY, which accepts GB/GBP cash and refuses any other market.

```
(cd "$B" && bash host-live-config.sh) > live-config-after-activation.txt 2>&1
```

## Undo

- `deactivate-gb.sql` switches the policy, both campaigns and the GB PIN key off.
- `deactivate-gb-cash.sql` turns GB cash off. Also unset `VAYDU_CASH_RIDE_BOOKING` and redeploy the API.

Both keep history: published versions, campaigns, frozen fee quotes, applied discounts, earned rewards,
enrolments and audit rows. Bookings made while a feature was on keep the terms frozen into them.

## Evidence (local rehearsal on develop's live schema + release 1 + release 2)

`scripts/release/rehearse-release-2.sh`, section "GB activation":
- **Activation:** runs twice with no difference.
- **Real functions** (`check-activated.sql`, 12/12):
  - a GB booking accepted 5 min ago owes 300;
  - within 120 s nothing is owed;
  - an NG booking owes nothing;
  - a promo on £12.50 gives 62;
  - the second use is refused;
  - £7.00 is below the minimum;
  - £200 is capped at 500.
- **NG untouched:** NG gets no policy and no campaign, and its existing PIN setting is unchanged.
- **Deactivation** (`check-deactivated.sql`, 3/3): everything off, history kept, NG untouched.
- **Cash:**
  - refused for an NG account;
  - enabled for GB/GBP only, with `fare-split-v1`;
  - VERIFY accepts GB cash and refuses NG cash;
  - deactivation turns it off and keeps the enrolment.
