-- Driver-ranking disposable-PG fixture.
-- Minimal jobs + ratings schema for the canonical driver_ranking_scores_v23 RPC.

CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  driver_id uuid,
  customer_id uuid,
  status text,
  pickup_lat numeric, pickup_lng numeric
);

CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid,
  customer_id uuid,
  score numeric,
  created_at timestamptz DEFAULT now()
);
