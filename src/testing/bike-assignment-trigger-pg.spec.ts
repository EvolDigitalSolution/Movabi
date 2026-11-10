import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sql = `
BEGIN;

CREATE TEMP TABLE test_results ("case" text, outcome text, detail text);

INSERT INTO profiles (id, role, tenant_id, country_code, currency_code) VALUES
    ('11111111-1111-1111-1111-111111111111', 'driver', '22222222-2222-2222-2222-222222222222', 'GB', 'GBP'),
    ('33333333-3333-3333-3333-333333333333', 'driver', '22222222-2222-2222-2222-222222222222', 'GB', 'GBP'),
    ('44444444-4444-4444-4444-444444444444', 'driver', '22222222-2222-2222-2222-222222222222', 'GB', 'GBP'),
    ('55555555-5555-5555-5555-555555555555', 'driver', '66666666-6666-6666-6666-666666666666', 'GB', 'GBP')
ON CONFLICT (id) DO NOTHING;

INSERT INTO vehicles (id, user_id, type, vehicle_subtype, status) VALUES
    ('99999999-9999-9999-9999-999999999991', '11111111-1111-1111-1111-111111111111', 'bike', 'pedal_bicycle', 'approved'),
    ('99999999-9999-9999-9999-999999999992', '33333333-3333-3333-3333-333333333333', 'car', null, 'approved'),
    ('99999999-9999-9999-9999-999999999993', '44444444-4444-4444-4444-444444444444', 'bike', 'pedal_bicycle', 'pending'),
    ('99999999-9999-9999-9999-999999999994', '55555555-5555-5555-5555-555555555555', 'bike', 'pedal_bicycle', 'approved')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    bike_snapshot jsonb := '{"category":"bike","allowed_subtypes":["pedal_bicycle"],"bike_limits":{"pedal_bicycle":{"max_kg":5,"max_cm":40}},"required_max_kg":5,"required_max_cm":40}'::jsonb;
    v_job_id uuid;
    v_reassign_id uuid;
BEGIN
    v_job_id := 'a0000000-0000-0000-0000-000000000001';
    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES (v_job_id, '22222222-2222-2222-2222-222222222222', 'GB', '11111111-1111-1111-1111-111111111111', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('approved bike INSERT', 'PASS', null);
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES ('approved bike INSERT', 'FAIL', SQLSTATE || ': ' || SQLERRM);
    END;

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES ('a0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'GB', '33333333-3333-3333-3333-333333333333', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('car for bike INSERT', 'FAIL', 'expected exception');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%requires an approved Bike%' OR SQLERRM LIKE '%VF002%' THEN
            INSERT INTO test_results VALUES ('car for bike INSERT', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('car for bike INSERT', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES ('a0000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'GB', '44444444-4444-4444-4444-444444444444', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('pending vehicle INSERT', 'FAIL', 'expected exception');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%not approved%' OR SQLERRM LIKE '%VF010%' THEN
            INSERT INTO test_results VALUES ('pending vehicle INSERT', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('pending vehicle INSERT', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES ('a0000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'GB', '55555555-5555-5555-5555-555555555555', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('wrong tenant INSERT', 'FAIL', 'expected exception');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%tenant%' OR SQLERRM LIKE '%DRIVER_MARKET_MISMATCH%' OR SQLERRM LIKE '%VF008%' THEN
            INSERT INTO test_results VALUES ('wrong tenant INSERT', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('wrong tenant INSERT', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, accepted_driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES ('a0000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'GB', '11111111-1111-1111-1111-111111111111', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('accepted_driver_id bike', 'PASS', null);
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES ('accepted_driver_id bike', 'FAIL', SQLSTATE || ': ' || SQLERRM);
    END;

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id, accepted_driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES ('a0000000-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222222', 'GB', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'bike', bike_snapshot);
        INSERT INTO test_results VALUES ('conflicting driver_id car', 'FAIL', 'expected exception on driver_id');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%requires an approved Bike%' OR SQLERRM LIKE '%VF002%' THEN
            INSERT INTO test_results VALUES ('conflicting driver_id car', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('conflicting driver_id car', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;

    UPDATE jobs SET status = 'open' WHERE id = v_job_id;
    INSERT INTO test_results VALUES ('non-assignment UPDATE', 'PASS', null);

    BEGIN
        INSERT INTO jobs (id, tenant_id, country_code, driver_id)
        VALUES ('a0000000-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222222', 'GB', '11111111-1111-1111-1111-111111111111');
        INSERT INTO test_results VALUES ('historical no category', 'PASS', null);
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES ('historical no category', 'FAIL', SQLSTATE || ': ' || SQLERRM);
    END;

    BEGIN
        v_reassign_id := 'a0000000-0000-0000-0000-000000000009';
        INSERT INTO jobs (id, tenant_id, country_code, accepted_driver_id, fulfilment_category, fulfilment_snapshot)
        VALUES (v_reassign_id, '22222222-2222-2222-2222-222222222222', 'GB', '11111111-1111-1111-1111-111111111111', 'bike', bike_snapshot);
        UPDATE jobs SET accepted_driver_id = '33333333-3333-3333-3333-333333333333' WHERE id = v_reassign_id;
        INSERT INTO test_results VALUES ('reassign to car UPDATE', 'FAIL', 'expected exception');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%requires an approved Bike%' OR SQLERRM LIKE '%VF002%' THEN
            INSERT INTO test_results VALUES ('reassign to car UPDATE', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('reassign to car UPDATE', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;

    BEGIN
        UPDATE jobs SET accepted_driver_id = '11111111-1111-1111-1111-111111111111' WHERE id = v_reassign_id;
        INSERT INTO test_results VALUES ('admin assign to bike', 'PASS', null);
    EXCEPTION WHEN OTHERS THEN
        INSERT INTO test_results VALUES ('admin assign to bike', 'FAIL', SQLSTATE || ': ' || SQLERRM);
    END;

    BEGIN
        UPDATE jobs SET driver_id = '33333333-3333-3333-3333-333333333333' WHERE id = v_job_id;
        INSERT INTO test_results VALUES ('direct RPC car UPDATE', 'FAIL', 'expected exception');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%requires an approved Bike%' OR SQLERRM LIKE '%VF002%' THEN
            INSERT INTO test_results VALUES ('direct RPC car UPDATE', 'PASS', SQLSTATE || ': ' || SQLERRM);
        ELSE
            INSERT INTO test_results VALUES ('direct RPC car UPDATE', 'FAIL', SQLSTATE || ': ' || SQLERRM);
        END IF;
    END;
END $$;

SELECT json_agg(row_to_json(test_results))::text FROM test_results;

ROLLBACK;
`;

describe('Bike assignment trigger (real PostgreSQL)', () => {
    it('enforces bike-only assignment across insert, accept, reassign and admin paths', () => {
        const tmp = join(tmpdir(), `bike-trigger-${Date.now()}.sql`);
        writeFileSync(tmp, sql, 'utf8');
        try {
            const output = execSync(`docker exec -i vaydu-pg-fresh psql -At -U postgres -d movabi_develop -v ON_ERROR_STOP=1 < "${tmp}"`, { encoding: 'utf8' });
            const match = output.match(/\[.*\]/s);
            const results = JSON.parse(match?.[0] || '[]');
            expect(Array.isArray(results)).toBe(true);
            expect(results.length).toBeGreaterThan(0);
            for (const r of results) {
                expect(r.outcome, `${r.case}: ${r.detail}`).toBe('PASS');
            }
        } finally {
            try { unlinkSync(tmp); } catch {}
        }
    });
});
