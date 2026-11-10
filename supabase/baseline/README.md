# Schema inputs for the isolated fixture

## Authoritative deployed export (test fixture)

File: `deployed_public_schema.sql`

| Property | Value |
|---|---|
| Source | `movabi-develop-db` / `movabi_develop` |
| Export | `pg_dump -s -n public --no-owner` (schema only) |
| SHA-256 | `0e9cade63433fc9065fd9282b017e3874332701831b917e933c4b3db925e6857` |
| Size | 769,889 bytes |
| Tables / functions / triggers / policies | 119 / 196 / 71 / 132 |
| Grants / revokes | 732 / 159 |
| Data rows (`COPY`) / owners / credentials | 0 / 0 / none |
| `public.tenants`, `profiles.verification_status`, `profiles.onboarding_completed` | present |
| `auth.uid()` references | 144 (resolved by GoTrue, not by this file) |

This export is authoritative for **what is deployed**. It is the fixture input
for the authenticated Bike HTTP test.

## Divergent snapshot (evidence only)

File: `public_schema.sql`

Exported from the local disposable `vaydu-pg-fresh` clone. It has only 36
tables and lacks `public.tenants` and the historical `profiles` columns
(`verification_status`, `onboarding_completed`, `email`), while containing later
migration objects. It is **not** a current baseline and is retained only as
review evidence.

## Candidate additions

`candidate/001_tenants.sql` contains exactly the `public.tenants` DDL from
`supabase/migrations/20260403000002_multi_tenant_security.sql`. It is applied
idempotently after the schema restore so the fixture also works with the
divergent snapshot. The deployed export already contains `tenants`, so the
candidate is a no-op there.

No migration is replayed blindly: only this reviewed table definition is added,
and only when absent.

### Vehicle approval (no `vehicles.status`)

Approval is read from the canonical authority: `vehicles.vehicle_verified`
(written by `server/routes/verification.routes.ts`) with `vehicles.is_verified`
as the legacy flag. `vehicles.status` is deliberately **not** added and no
existing row is defaulted to approved. The guard migration
`20261261000000_bike_guard_snapshot_authority.sql` replaces
`enforce_job_vehicle_category()` accordingly.

### Frozen snapshot enforcement

`20261261000000` makes the frozen `jobs.fulfilment_snapshot` authoritative.
Legacy `fulfilment_category` and `metadata.service_vehicle_class` are validated
against it; a contradiction raises `VF011` instead of allowing a car into a Bike
job. A legacy booking with no snapshot, no category and no metadata keeps the
historical unenforced behaviour.

### Auth-schema shims

`auth.job_messages` and `auth.debug_errand_insert()` are outside the `public`
export (they live in the `auth` schema). They are created as fixture-only
stubs. Neither is on the tested path: `send_job_message` is not called by
acceptance, and `debug_errand_insert_trigger` is on `errand_details`, not
`jobs`/`vehicles`. The stubs therefore cannot weaken the assignment assertions.
A production bootstrap must create the real definitions (GoTrue does not).

## Auth bootstrap (pinned, proven)

1. `postgres:16.15` disposable database, synthetic password.
2. Roles `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator`
   (with password for PostgREST v10.1.2), and an **empty** `auth` schema.
3. `supabase/gotrue:v2.132.3` runs its own migrations: `auth.users`,
   `auth.uid()`, auth tables. (Proven: GoTrue fails
   `00_init_auth_schema.up.sql` when the `auth` schema is absent.)
4. Restore `deployed_public_schema.sql` into `public` (schema only). The file
   references `auth.users`/`auth.uid()`, which GoTrue has already created.
5. `postgrest/postgrest:v10.1.2` with `PGRST_DB_ANON_ROLE=anon`.
6. Create synthetic users via GoTrue `/signup`; never insert auth rows by hand.

PostgREST does **not** provide `auth.uid()`; GoTrue does.

