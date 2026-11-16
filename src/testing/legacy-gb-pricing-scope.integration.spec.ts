import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Actual pricing selection/calculation, with only the data transport and unrelated fee/market
// layers controlled. Rows are read back from PostgreSQL before/after the real correction SQL.
const transport = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {
    from(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        const q: any = { select: () => q, in: (k: string, v: any[]) => { filters.push(r => v.includes(r[k])); return q; },
            eq: (k: string, v: any) => { filters.push(r => r[k] === v); return q; },
            order: async () => ({ data: (table === 'pricing_config' ? transport.rows : []).filter(r => filters.every(f => f(r))), error: null }) };
        return q;
    }
} }));
vi.mock('../../server/services/market-pricing.service', () => ({ resolveMarketPricingStrategy: async () => null,
    MarketPricingService: { evaluate: async () => null } }));
import { MarketplaceConfigService as config } from '../../server/services/marketplace-config.service';
import { PricingService } from '../../server/services/pricing.service';

const container = 'vaydu-gb-scope-test-' + randomUUID().slice(0, 8);
let owned = false;
const act = 'deploy/vaydu-develop-activation/';
const correction = readFileSync(act + 'correct-legacy-gb-pricing.sql', 'utf8');
const activation = readFileSync(act + 'activate-gb.sql', 'utf8');
const cash = readFileSync(act + 'activate-gb-cash.sql', 'utf8');
const base = readFileSync('supabase/baseline/develop_live_public_schema_20261112.sql', 'utf8');
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function sql(input: string, args: string[] = [], database = 'movabi_develop') {
    const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', database,
        '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { input, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `psql exit ${r.status}`);
    return r.stdout.trim();
}
const all = () => JSON.parse(sql("select jsonb_agg(to_jsonb(p) order by id) from pricing_config p"));
const snapshot = () => sql("select jsonb_agg(to_jsonb(p) order by id) from pricing_config p where id::text like '10000000-%'");
const correct = (s = snapshot()) => sql(correction, ['-v', `expected_rows_json=${s}`]);
const lookupBlock = activation.slice(activation.indexOf('CREATE TEMP TABLE gb_tenants'), activation.indexOf('-- P8 preconditions'));
const minBlock = activation.slice(activation.indexOf('CREATE TEMP TABLE gb_min'), activation.indexOf('CREATE TEMP TABLE gb_tenants'));
async function quotes() {
    transport.rows = all();
    const result: any[] = [];
    for (const country of ['GB', 'NG']) for (const service of ['ride', 'delivery', 'errand', 'van-moving']) {
        const currency = country === 'GB' ? 'GBP' : 'NGN';
        const effective = await config.getEffectivePricingConfig(service, { countryCode: country, currencyCode: currency });
        expect(effective.source).toBe('pricing_config');
        if (country === 'GB' && service === 'ride') expect(effective.minimumFare).toBe(3.35);
        for (const [distanceKm, durationMinutes] of [[0, 0], [5, 10]]) {
            const quote = await PricingService.resolvePrice({ lat: 0, lng: 0, countryCode: country, currencyCode: currency,
                serviceSlug: service, distanceKm, durationMinutes, requestedAt: '2026-11-16T12:00:00Z' });
            expect(quote.currencyCode).toBe(currency);
            expect(quote.source).toBe('pricing_config');
            expect(quote.fareBreakdown.reconciliationValid).toBe(true);
            result.push({ effective, quote });
        }
    }
    return result;
}

beforeAll(async () => {
    execFileSync('docker', ['run', '-d', '--name', container, '--network', 'none', '-e', 'POSTGRES_PASSWORD=disposable-scope-test', 'postgres:16.15'], { timeout: 30000 });
    owned = true;
    for (let i = 0; i < 100; i++) {
        try { sql('select 1', [], 'postgres'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    sql('CREATE DATABASE movabi_develop', [], 'postgres');
    let fixture = '';
    for (const table of ['pricing_config', 'audit_logs', 'profiles']) {
        fixture += base.match(new RegExp(`CREATE TABLE public\\.${table} \\(.*?\n\\);`, 's'))![0] + '\n';
        fixture += base.match(new RegExp(`ALTER TABLE ONLY public\\.${table}\\s+ADD CONSTRAINT \\w+ PRIMARY KEY \\(id\\);`))![0] + '\n';
    }
    fixture += base.match(/CREATE UNIQUE INDEX idx_pricing_config_market_service.*?;/s)![0] + '\n';
    fixture += base.match(/CREATE FUNCTION public\.set_pricing_config_updated_at\(\).*?\$\$;/s)![0] + '\n';
    fixture += base.match(/CREATE TRIGGER trg_pricing_config_updated_at.*?;/s)![0] + '\n';
    fixture += base.match(/CREATE FUNCTION public\.wallet_currency_minor_exponent\(.*?\$_\$;/s)![0] + '\n';
    fixture += 'CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid, email text);';
    sql(fixture);
}, 120000);
afterAll(() => { if (owned) execFileSync('docker', ['rm', '-f', container]); });
beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(config, 'getEffectiveDynamicPricingConfig').mockResolvedValue({ enabled: false } as any);
    vi.spyOn(config, 'getEffectiveCommissionConfig').mockResolvedValue({ enabled: true, percent: 15 } as any);
    vi.spyOn(config, 'getEffectivePlatformFeeConfig').mockResolvedValue({ enabled: true, type: 'percentage', percent: 5,
        fixedAmount: 0, minFee: 0, maxFee: null, source: 'marketplace_settings' } as any);
    vi.spyOn(config, 'determineJobModes').mockResolvedValue({ negotiation: false, bidding: false } as any);
    sql(`TRUNCATE pricing_config,audit_logs,profiles,auth.users;
      INSERT INTO pricing_config(id,service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code,created_at,updated_at)
      SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,s,2.75,0.65,0.10,0.20,
        CASE WHEN s='ride' THEN 3.35 ELSE 4.25 END,'GBP','','2026-11-01','2026-11-02'
      FROM unnest(ARRAY['ride','delivery','errand','van-moving']) WITH ORDINALITY t(s,n);
      INSERT INTO pricing_config(id,service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code)
      SELECT ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,s,1000,200,30,50,1500,'NGN','NG'
      FROM unnest(ARRAY['ride','delivery','errand','van-moving']) WITH ORDINALITY t(s,n);
      INSERT INTO profiles(id,tenant_id,role,registration_country_code,country_code) VALUES
        ('${uuid(11)}','${uuid(91)}','customer','','GB'),('${uuid(12)}','${uuid(92)}','driver',NULL,'GB'),
        ('${uuid(13)}','${uuid(93)}','customer','   ',' GB '),('${uuid(14)}','${uuid(94)}','driver','NG','GB'),
        ('${uuid(15)}','${uuid(95)}','customer',NULL,'NG');
      INSERT INTO auth.users SELECT id,id::text||'@test.invalid' FROM profiles;`);
});

describe('exact live legacy shape: four blank GBP countries, ride min GBP 3.35, explicit NG rows', () => {
    it('guard fails before correction; 16 actual GB/NG quotes and every other field are identical afterwards', async () => {
        const before = all(), s = snapshot(), q = await quotes();
        expect(() => sql('BEGIN; ' + minBlock + 'ROLLBACK;')).toThrow(/minimum fare is not exactly one positive value/);
        correct(s);
        expect(await quotes()).toEqual(q);
        const after = all();
        expect(after).toEqual(before.map((r: any) => r.id.startsWith('10000000-') ? { ...r, country_code: 'GB' } : r));
        expect(sql('BEGIN; ' + minBlock + 'SELECT minor FROM gb_min; ROLLBACK;')).toBe('335');
        expect(sql("select count(*) from audit_logs where action='admin_develop_pricing_scope'")).toBe('4');
        expect(sql("select bool_and(metadata->'before'->>'country_code'='' AND metadata->'after'->>'country_code'='GB') from audit_logs")).toBe('t');
        correct(s);
        expect(sql('select count(*) from audit_logs')).toBe('4');
        expect(all()).toEqual(after);
        expect(sql("select tgenabled from pg_trigger where tgname='trg_pricing_config_updated_at'")).toBe('O');
    }, 30000);
    it('recognises blank, NULL and whitespace registration markets; nonblank NG registration keeps precedence', () => {
        expect(sql('BEGIN; ' + lookupBlock + 'SELECT string_agg(tenant_id::text,\',\' ORDER BY tenant_id) FROM gb_tenants; ROLLBACK;'))
            .toBe([uuid(91), uuid(92), uuid(93)].join(','));
        const driverLookup = cash.slice(cash.indexOf('CREATE TEMP TABLE cash_driver'), cash.indexOf('DO $c$'));
        expect(sql('BEGIN; ' + driverLookup + 'SELECT driver_id FROM cash_driver; ROLLBACK;', ['-v', `driver_email=${uuid(12)}@test.invalid`])).toBe(uuid(12));
        sql(`UPDATE profiles SET registration_country_code='' WHERE id='${uuid(12)}'`);
        expect(sql('BEGIN; ' + driverLookup + 'SELECT driver_id FROM cash_driver; ROLLBACK;', ['-v', `driver_email=${uuid(12)}@test.invalid`])).toBe(uuid(12));
    });
    it('fails without changing any pricing/audit/trigger state when an explicit GB national scope conflicts', () => {
        sql("INSERT INTO pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code) VALUES('ride',9,1,1,1,9,'GBP',' gb ')");
        const before = all();
        expect(() => correct()).toThrow(/conflicting explicit GB/);
        expect(all()).toEqual(before);
        expect(sql('select count(*) from audit_logs')).toBe('0');
        expect(sql("select tgenabled from pg_trigger where tgname='trg_pricing_config_updated_at'")).toBe('O');
    });
    it('fails on stale snapshots, wrong counts and a changed ride minimum', () => {
        const s = snapshot();
        sql(`UPDATE pricing_config SET per_km=0.66 WHERE id='${uuid(1)}'`);
        const before = all();
        expect(() => correct(s)).toThrow(/changed since snapshot/);
        expect(all()).toEqual(before);
        expect(() => correct('[]')).toThrow(/exactly four/);
        sql(`UPDATE pricing_config SET minimum_fare=3.36 WHERE id='${uuid(1)}'`);
        expect(() => correct()).toThrow(/ride minimum 3.35/);
        expect(sql('select count(*) from audit_logs')).toBe('0');
    });
    it('handles NULL countries too, and never promotes unrelated GBP/city pricing into GB', () => {
        sql("UPDATE pricing_config SET country_code=NULL WHERE id::text like '10000000-%'; INSERT INTO pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code,market_city) VALUES('ride',99,1,1,1,99,'GBP','','unconfirmed-market')");
        const before = all();
        correct();
        expect(all()).toEqual(before.map((r: any) => r.id.startsWith('10000000-') ? { ...r, country_code: 'GB' } : r));
    });
    it.each([['ALWAYS', 'A'], ['REPLICA', 'R'], ['DISABLE', 'D']])('preserves the original timestamp trigger mode %s', (mode, expected) => {
        sql(`ALTER TABLE pricing_config ${mode === 'DISABLE' ? 'DISABLE' : 'ENABLE ' + mode} TRIGGER trg_pricing_config_updated_at`);
        const before = all();
        correct();
        expect(all()).toEqual(before.map((r: any) => r.id.startsWith('10000000-') ? { ...r, country_code: 'GB' } : r));
        expect(sql("select tgenabled from pg_trigger where tgname='trg_pricing_config_updated_at'")).toBe(expected);
    });
    it('refuses an unaudited explicit-GB state and a non-develop database', () => {
        const s = snapshot();
        sql("ALTER TABLE pricing_config DISABLE TRIGGER trg_pricing_config_updated_at; UPDATE pricing_config SET country_code='GB' WHERE id::text like '10000000-%'; ALTER TABLE pricing_config ENABLE TRIGGER trg_pricing_config_updated_at");
        const before = all();
        expect(() => correct(s)).toThrow(/not the audited correction/);
        expect(all()).toEqual(before);
        expect(() => sql(correction, ['-v', `expected_rows_json=${s}`], 'postgres')).toThrow(/develop only/);
    });
    it('an unexpected row-changing trigger rolls the whole correction back and restores the timestamp trigger', () => {
        sql("CREATE FUNCTION corrupt_pricing_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.per_km:=NEW.per_km+1; RETURN NEW; END $$; CREATE TRIGGER unexpected_test BEFORE UPDATE ON pricing_config FOR EACH ROW EXECUTE FUNCTION corrupt_pricing_test()");
        const before = all();
        try {
            expect(() => correct()).toThrow(/fields other than country_code changed/);
            expect(all()).toEqual(before);
            expect(sql('select count(*) from audit_logs')).toBe('0');
            expect(sql("select tgenabled from pg_trigger where tgname='trg_pricing_config_updated_at'")).toBe('O');
        } finally { sql('DROP TRIGGER unexpected_test ON pricing_config; DROP FUNCTION corrupt_pricing_test()'); }
    });
});
