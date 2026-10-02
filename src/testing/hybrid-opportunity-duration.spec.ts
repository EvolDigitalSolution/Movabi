import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const FIX_MIGRATION = 'supabase/migrations/20261230000000_hybrid_opportunity_duration_fix.sql';
const RECONCILE = 'supabase_incremental_schema_reconcile.sql';
const HARDENING = 'supabase/migrations/20261203000000_release_authority_hardening.sql';

const fix = read(FIX_MIGRATION);
const reconcile = read(RECONCILE);

/** The defective executable forms that produced 22P02 (matched with their alias so
 *  the explanatory comments that quote the old defect are not counted as code). */
const DEFECTIVE_STATEMENTS = [
  "(j.metadata->>'duration_seconds')::INTEGER AS eta_seconds",
  "NULLIF(j.metadata->>'duration_seconds', '')::INTEGER AS eta_seconds"
];

/** Behavioural mirror of the SQL: regex guard, decimal parse, ROUND, clamp to INTEGER max. */
const toEtaSeconds = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return null;
  return Math.min(2147483647, Math.round(Number(text)));
};

describe('fetch_hybrid_opportunities — fractional duration (22P02) fix', () => {
  it('A. fractional duration 643.9 rounds to 644', () => {
    expect(toEtaSeconds('643.9')).toBe(644);
    // The exact production value: 643.9s == the logged durationMinutes 10.73
    expect(643.9 / 60).toBeCloseTo(10.73, 2);
  });

  it('B. integer duration 643 stays 643', () => {
    expect(toEtaSeconds('643')).toBe(643);
    expect(toEtaSeconds('0')).toBe(0);
  });

  it('C. empty duration becomes NULL', () => {
    expect(toEtaSeconds('')).toBeNull();
    expect(toEtaSeconds('   ')).toBeNull();
  });

  it('D. missing duration becomes NULL', () => {
    expect(toEtaSeconds(null)).toBeNull();
    expect(toEtaSeconds(undefined)).toBeNull();
  });

  it('E. malformed metadata yields NULL instead of raising (no exception path)', () => {
    for (const malformed of ['abc', '64s3', '1e3', '.5', '-643.9', '+643', '643,9', '{}', 'null', 'NaN', 'Infinity']) {
      expect(toEtaSeconds(malformed), malformed).toBeNull();
    }
    // Numeric-but-absurd must not raise 22003 either: it clamps.
    expect(toEtaSeconds('99999999999999999999')).toBe(2147483647);
  });

  it('F. the driver identity-binding guard is present in the fix AND the reconcile', () => {
    for (const [label, sql] of [['fix', fix], ['reconcile', reconcile]] as const) {
      expect(sql, `${label} must compare auth.uid() to p_driver_id`)
        .toContain('IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN');
      expect(sql, `${label} must raise on a foreign driver id`)
        .toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
      // The guard must still test the real parameter, never a literal.
      expect(sql).toContain('p_driver_id UUID');
    }
  });

  it('F2. the reconcile regression is closed: guard present, defective cast gone', () => {
    // Match the executable STATEMENT form (with its alias), so the explanatory
    // comments that quote the old defect are not mistaken for live code.
    const defectiveStatements = [
      "(j.metadata->>'duration_seconds')::INTEGER AS eta_seconds",
      "NULLIF(j.metadata->>'duration_seconds', '')::INTEGER AS eta_seconds",
      "NULLIF(j.metadata->>'distance_km', '')::NUMERIC AS distance_km"
    ];
    for (const defective of defectiveStatements) {
      expect(reconcile, `reconcile must not contain ${defective}`).not.toContain(defective);
      expect(fix, `fix migration must not contain ${defective}`).not.toContain(defective);
    }
    expect(reconcile).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(reconcile).toContain('ROUND((BTRIM(j.metadata->>\'duration_seconds\'))::NUMERIC)');
  });

  it('the fix migration is ordered after every earlier definition (last writer wins)', () => {
    // A fresh, in-order migration run must converge on the corrected function.
    expect(FIX_MIGRATION > 'supabase/migrations/20261203000000_release_authority_hardening.sql').toBe(true);
    expect(FIX_MIGRATION > 'supabase/migrations/20261229000000_profiles_authorization_hardening.sql').toBe(true);
    expect(fix).toContain('CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities(');
  });

  it('G. the returned column contract is unchanged', () => {
    const columns = [
      'session_id UUID', 'job_id UUID', 'customer_id UUID',
      'suggested_fare NUMERIC', 'customer_offer NUMERIC',
      'distance_km NUMERIC', 'eta_seconds INTEGER',
      'service_name TEXT', 'service_slug TEXT',
      'pickup_address TEXT', 'dropoff_address TEXT'
    ];
    for (const column of columns) {
      expect(fix, `fix must declare ${column}`).toContain(column);
      expect(reconcile, `reconcile must declare ${column}`).toContain(column);
    }
    // eta_seconds must remain INTEGER and distance_km NUMERIC.
    expect(fix).toContain('eta_seconds INTEGER');
    expect(fix).toContain('distance_km NUMERIC');
  });

  it('G2. the RPC name, parameter signature and ACL are unchanged', () => {
    expect(fix).toContain('public.fetch_hybrid_opportunities(uuid)');
    expect(fix).toContain('p_driver_id UUID');
    // No extra parameters were introduced to work around the cast.
    expect(fix).not.toContain('p_duration');
    expect(fix).not.toContain('p_radius');
    expect(fix).toContain('REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM PUBLIC;');
    expect(fix).toContain('REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM anon;');
    expect(fix).toContain('GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) TO authenticated, service_role;');
  });

  it('the session/job/decline filters are unchanged (eligibility not broadened)', () => {
    for (const sql of [fix, reconcile]) {
      expect(sql).toContain("s.status IN ('open', 'released')");
      expect(sql).toContain('s.active_driver_id IS NULL');
      expect(sql).toContain('FROM public.driver_job_declines d');
      expect(sql).toContain('d.driver_id = p_driver_id AND d.job_id = s.job_id');
    }
  });

  it('distance_km gets the same guard (identical defect class in the same SELECT)', () => {
    for (const sql of [fix, reconcile]) {
      expect(sql).toContain("BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\\.[0-9]+)?$'");
    }
  });

  it('the hardening migration is left as applied history, guard intact', () => {
    const hardening = read(HARDENING);
    expect(hardening).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
    expect(hardening).toContain('p_driver_id UUID');
  });

  it('the client call contract is untouched (single uuid argument)', () => {
    const client = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');
    expect(client).toContain(".rpc('fetch_hybrid_opportunities', { p_driver_id: driverId })");
    // No client-side rounding was added as a substitute for the SQL fix.
    expect(client).not.toContain('durationSeconds: Math.round');
  });
});
