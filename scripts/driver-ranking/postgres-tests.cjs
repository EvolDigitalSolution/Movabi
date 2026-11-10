const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Client } = require(process.env.MOVABI_PG_MODULE || 'pg');
// The ACTUAL production ranking function — not a reimplementation.
const { rankEligibleDrivers, confidenceAdjustedRating } = require(path.join(__dirname, '../../server/services/driver-ranking.ts'));

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // 100 reviews @ 5.0
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'; // 100 reviews @ 3.0
const C = 'cccccccc-cccc-4ccc-8ccc-000000000003'; // 1 review @ 5.0
const D = 'dddddddd-dddd-4ddd-8ddd-000000000004'; // 0 reviews (new driver)
const E = 'eeeeeeee-eeee-4eee-8eee-000000000005'; // only invalid reviews (excluded)
const F = 'ffffffff-ffff-4fff-8fff-000000000006'; // 105 reviews, latest 100 @ 5.0

let db, seq = 0;
const q = (sql, args = []) => db.query(sql, args);
const newCustomer = () => `99999999-9999-4999-8999-${String(++seq).padStart(12, '0')}`;

async function review(driverId, score, createdAt, opts = {}) {
  const jobId = `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const customerId = opts.customerId ?? newCustomer();
  await q(`INSERT INTO jobs(id, driver_id, customer_id, status) VALUES($1,$2,$3,$4)`,
    [jobId, driverId, customerId, opts.status ?? 'completed']);
  if (opts.ratingCustomerId !== undefined || opts.ratingScore !== undefined || score !== null) {
    await q(`INSERT INTO ratings(job_id, customer_id, score, created_at) VALUES($1,$2,$3,$4)`,
      [jobId, opts.ratingCustomerId ?? customerId, opts.ratingScore ?? score, createdAt]);
  }
  return jobId;
}

async function scores(ids) {
  return (await q('SELECT * FROM driver_ranking_scores_v23($1::uuid[])', [ids])).rows;
}

const at = (id, lat = 0, lng = 0) => ({ id, lat, lng });

(async () => {
  db = new Client({ connectionString: process.env.MOVABI_TEST_DATABASE_URL });
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261023170000_driver_ranking_scores.sql'), 'utf8'));

  // Seed rating histories.
  const t = (n) => new Date(Date.UTC(2026, 9, 23, 12, 0, n % 60)).toISOString();
  for (let i = 0; i < 100; i++) { await review(A, 5.0, t(i)); }
  for (let i = 0; i < 100; i++) { await review(B, 3.0, t(i)); }
  await review(C, 5.0, t(0));
  // D is seeded with no reviews (new driver).
  // E: only invalid/excluded reviews.
  await review(E, 5.0, t(0), { status: 'cancelled' });                 // non-completed
  await review(E, 5.0, t(1), { customerId: E });                       // self-rating (customer == driver)
  await review(E, 0, t(2));                                            // score out of range (0)
  await review(E, 6, t(3));                                            // score out of range (6)
  await review(E, 4.5, t(4));                                          // non-integer score
  await review(E, 5.0, t(5), { ratingCustomerId: newCustomer() });     // mismatched rating customer
  // F: 105 reviews; oldest 5 are 1.0, latest 100 are 5.0.
  for (let i = 0; i < 5; i++) await review(F, 1.0, new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString());
  for (let i = 0; i < 100; i++) await review(F, 5.0, t(i));

  const rows = await scores([A, B, C, D, E, F]);
  const byId = new Map(rows.map(r => [r.driver_id, { average: Number(r.average_score), count: Number(r.review_count) }]));

  // Exact persisted scores (SQL history).
  assert.deepEqual(byId.get(A), { average: 5.0, count: 100 }, 'A 100x5.0');
  assert.deepEqual(byId.get(B), { average: 3.0, count: 100 }, 'B 100x3.0');
  assert.deepEqual(byId.get(C), { average: 5.0, count: 1 }, 'C 1x5.0');
  assert.equal(byId.get(D), undefined, 'new driver D has no review row');
  assert.equal(byId.get(E), undefined, 'exclusion driver E has no valid review');
  assert.deepEqual(byId.get(F), { average: 5.0, count: 100 }, 'F latest-100 window (oldest 5 dropped)');

  // Feed the real SQL scores into the ACTUAL production ranking function.
  const pickup = { lat: 0, lng: 0 };
  const drivers = [at(A), at(B), at(C), at(D)];

  // Agreed ordering at equal distance (rating + new-driver prior, no formula reimplementation).
  assert.deepEqual(rankEligibleDrivers(drivers, pickup, byId).map(d => d.id), [A, C, D, B],
    'ordering: strong (A) > single-review (C) > new-driver prior (D) > weak (B)');

  // Rating tie-break: equal raw average, more reviews wins (confidence).
  assert.deepEqual(rankEligibleDrivers([at(C), at(A)], pickup, byId).map(d => d.id), [A, C],
    'A (100 reviews) outranks C (1 review) at equal raw 5.0');

  // New-driver treatment: no reviews -> neutral prior 4.5.
  assert.equal(confidenceAdjustedRating(undefined), 4.5);
  assert.equal(confidenceAdjustedRating(byId.get(D)), 4.5);

  // Distance dominates when the geographic gap exceeds the rating allowance.
  const farStrong = { id: 'far-strong', lat: 0.02, lng: 0 };
  const nearWeak = { id: 'near-weak', lat: 0, lng: 0 };
  const mixed = new Map([['far-strong', { average: 5, count: 100 }], ['near-weak', { average: 1, count: 100 }]]);
  assert.equal(rankEligibleDrivers([farStrong, nearWeak], pickup, mixed)[0].id, 'near-weak',
    'nearby driver stays ahead when the distance gap exceeds the rating allowance');

  console.log('DRIVER_RANKING_TESTS=PASS');
  await db.end();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { try { await db.end(); } catch {} });
