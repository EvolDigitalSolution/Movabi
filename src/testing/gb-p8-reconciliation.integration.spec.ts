import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const transport = vi.hoisted(() => ({ tables: {} as Record<string, any[]> }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: { from(table: string) {
    const filters: Array<(r: any) => boolean> = [], orders: Array<[string, boolean]> = [];
    let maximum = Infinity, inserted: any[] | null = null;
    const matches = (r: any, expression: string) => expression.split(',').some(part => {
        const [, k, op, value] = part.match(/^([^.]+)\.(eq|is|lte|gte)\.(.*)$/) || [];
        return op === 'is' ? r[k] == null : op === 'eq' ? String(r[k]) === value : op === 'lte' ? r[k] <= value : op === 'gte' ? r[k] >= value : false;
    });
    const result = () => {
        let rows = (inserted || transport.tables[table] || []).filter(r => filters.every(f => f(r)));
        for (const [key, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (asc ? 1 : -1));
        return { data: rows.slice(0, maximum), error: null };
    };
    const q: any = { select: () => q, eq: (k: string, v: any) => { filters.push(r => r[k] === v); return q; },
        is: (k: string, v: any) => { filters.push(r => v === null ? r[k] == null : r[k] === v); return q; },
        in: (k: string, values: any[]) => { filters.push(r => values.includes(r[k])); return q; },
        or: (s: string) => { filters.push(r => matches(r, s)); return q; },
        gte: (k: string, v: any) => { filters.push(r => r[k] >= v); return q; },
        order: (k: string, o: any = {}) => { orders.push([k, o.ascending !== false]); return q; },
        limit: (n: number) => { maximum = n; return q; },
        insert: (r: any) => { inserted = [{ id: 'isolated-quote-audit', ...r }]; return q; },
        maybeSingle: async () => ({ data: result().data[0] || null, error: null }),
        single: async () => ({ data: result().data[0] || null, error: null }),
        then: (ok: any, no: any) => Promise.resolve(result()).then(ok, no) };
    return q;
} } }));
// All resolvers/calculators below are REAL, including strategy precedence, tenant settings,
// payment protection, market intelligence and global AI shadow. Only the DB transport is adapted.
import { PricingService } from '../../server/services/pricing.service';
import { MarketplaceConfigService as config } from '../../server/services/marketplace-config.service';
import { GlobalAiPricingService } from '../../server/services/global-ai-pricing.service';
import { resolveMarketPricingStrategy } from '../../server/services/market-pricing.service';

const name = 'vaydu-p8-test-' + randomUUID().slice(0, 8);
let owned = false;
const root = 'deploy/vaydu-develop-activation/';
const baseline = readFileSync('supabase/baseline/develop_live_public_schema_20261112.sql', 'utf8');
const correction = readFileSync(root + 'correct-gb-p8-strategies.sql', 'utf8');
const activation = readFileSync(root + 'activate-gb.sql', 'utf8');
const entry = JSON.parse(activation.match(/set_market_key\(t, 'dynamic_pricing', 'GB',\s*'([\s\S]*?)'::jsonb\)/)![1]);
const id = (n: number) => `41000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function sql(input: string, args: string[] = [], db = 'movabi_develop') {
    const r = spawnSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=disposable-p8', name, 'psql', '-X', '-h', '127.0.0.1', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAt', ...args], { input, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'psql failed');
    return r.stdout.trim();
}
const snapshot = () => sql("SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM market_pricing_strategies s WHERE country_code='GB'");
const all = (t: string) => JSON.parse(sql(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM ${t} t`));
const correct = (s = snapshot()) => sql(correction, ['-v', `expected_strategies_json=${s}`]);
function refresh() {
    for (const t of ['market_pricing_strategies', 'pricing_config', 'pricing_markets', 'marketplace_settings']) transport.tables[t] = all(t);
    transport.tables.service_market_rules = ['ride', 'errand', 'delivery', 'van-moving'].map(service => ({ country_code: 'GB', service_slug: service,
        zone_id: null, is_active: true, ai_pricing_enabled: true, surge_enabled: true, maximum_surge_multiplier: 3,
        base_fare_minor: 200, per_distance_unit_minor: 100, per_minute_minor: 20, minimum_fare_minor: 335 }));
    config.clearCache();
}
const options = (country = 'GB', tenant = id(91), demand = 0.2, traffic = 1) => ({ lat: 51.5, lng: 0,
    countryCode: country, currencyCode: country === 'GB' ? 'GBP' : 'NGN', tenantId: tenant, serviceSlug: 'ride',
    distanceKm: 5, durationMinutes: 10, demand, supply: 1, weatherMultiplier: traffic, trafficMultiplier: traffic, liveTraffic: traffic,
    requestedAt: '2026-11-16T12:00:00Z' });

beforeAll(async () => {
    execFileSync('docker', ['run', '-d', '--name', name, '--network', 'none', '-e', 'POSTGRES_PASSWORD=disposable-p8', 'postgres:16.15'], { timeout: 30000 });
    owned = true;
    for (let n = 0; n < 100; n++) { try { sql('select 1', [], 'postgres'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
    sql('CREATE DATABASE movabi_develop', [], 'postgres');
    let fixture = '';
    for (const t of ['market_pricing_strategies', 'pricing_config', 'pricing_markets', 'marketplace_settings', 'audit_logs', 'profiles', 'campaigns', 'cancellation_policies'])
        fixture += baseline.match(new RegExp(`CREATE TABLE public\\.${t} \\(.*?\n\\);`, 's'))![0] + '\n';
    sql(fixture);
}, 120000);
afterAll(() => { if (owned) execFileSync('docker', ['rm', '-f', name]); });
beforeEach(() => {
    transport.tables = {};
    sql(`TRUNCATE market_pricing_strategies,pricing_config,pricing_markets,marketplace_settings,audit_logs,profiles,campaigns,cancellation_policies;
      INSERT INTO market_pricing_strategies(id,country_code,currency,service_type,strategy,maximum_surge_multiplier,normal_demand_multiplier,busy_multiplier,commission_percent,minimum_launch_target_fare,updated_at,enabled)
        SELECT ('41000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'GB','GBP',s,'manual',3,1.1,2.5,17,3.35,'2026-11-01',true
        FROM unnest(ARRAY['ride','errand','delivery','van-moving']) WITH ORDINALITY t(s,n);
      INSERT INTO market_pricing_strategies(id,country_code,currency,service_type,maximum_surge_multiplier,normal_demand_multiplier,busy_multiplier,enabled)
        VALUES('${id(11)}','NG','NGN','ride',2.2,1,1.8,true),('${id(12)}','FR','EUR','ride',2.7,1,2.3,true);
      INSERT INTO pricing_config(id,service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code)
        SELECT ('51000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,s,2.75,.65,.1,.2,3.35,'GBP','GB'
        FROM unnest(ARRAY['ride','errand','delivery','van-moving']) WITH ORDINALITY t(s,n);
      INSERT INTO pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,country_code) VALUES('ride',1000,200,30,50,1500,'NGN','NG');
      INSERT INTO pricing_markets(country_code,currency_code,timezone,distance_unit,market_enabled,ai_pricing_enabled,shadow_mode_enabled,confidence_threshold)
        VALUES('GB','GBP','Europe/London','km',true,true,true,0),('NG','NGN','Africa/Lagos','km',true,false,true,.75);
      INSERT INTO profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
        ('${id(81)}','${id(91)}','customer','GB',''),('${id(82)}','${id(92)}','driver','GB',NULL);
      INSERT INTO marketplace_settings(tenant_id,key,value) VALUES(NULL,'market_pricing_shadow_mode','true'),(NULL,'market_pricing_enabled','true');
      INSERT INTO marketplace_settings(tenant_id,key,value) SELECT tenant,'dynamic_pricing',
        jsonb_build_object('enabled',true,'maxSurge',2.4,'trafficEnabled',true,'trafficMultiplier',1.3,'weatherEnabled',true,'weatherMultiplier',1.2,'fuelMultiplier',1.1,'markets',jsonb_build_object('GB','${JSON.stringify(entry)}'::jsonb))
        FROM unnest(ARRAY['${id(91)}'::uuid,'${id(92)}'::uuid]) t(tenant);
      INSERT INTO marketplace_settings(tenant_id,key,value) SELECT tenant,'platform_fee','{"enabled":true,"type":"percentage","percent":5,"fixedAmount":0}'::jsonb
        FROM unnest(ARRAY['${id(91)}'::uuid,'${id(92)}'::uuid]) t(tenant);
    `);
    refresh();
});

describe('P8 reconciliation with actual quote/resolver path and real PostgreSQL correction', () => {
    it('removes the bypass, preserves every unrelated strategy/AI field and caps real GB quotes in both tenants', async () => {
        const before = all('market_pricing_strategies'), aiBefore = all('pricing_markets'), s = snapshot();
        const old = await PricingService.resolvePrice(options());
        expect(old.dynamicPricingMultiplier).toBe(2.5);
        correct(s); refresh();
        expect(all('market_pricing_strategies')).toEqual(before.map((r: any) => r.country_code === 'GB'
            ? { ...r, maximum_surge_multiplier: 1.5, normal_demand_multiplier: 1, busy_multiplier: null } : r));
        expect(all('pricing_markets')).toEqual(aiBefore);
        for (const tenant of [id(91), id(92)]) for (const service of ['ride', 'errand', 'delivery', 'van-moving']) for (const [demand, supply] of [[0, 1], [0.2, 1], [50, 1], [50, 0]]) {
            const input = { ...options('GB', tenant, demand), serviceSlug: service, supply };
            const normal = await GlobalAiPricingService.resolveQuote(input);
            const stressed = await GlobalAiPricingService.resolveQuote({ ...input, trafficMultiplier: 9, liveTraffic: 9, weatherMultiplier: 9 });
            const p = normal.legacyPricing;
            expect(p.dynamicPricingMultiplier).toBeLessThanOrEqual(1.5);
            expect(p.dynamicPricingMultiplier).toBe(demand === 0 ? 1 : demand === 0.2 ? 1.1 : 1.5);
            expect(stressed.legacyPricing.totalPrice).toBe(p.totalPrice);
            expect(stressed.quote.price.totalMinor).toBe(normal.quote.price.totalMinor);
            expect(normal.quote.ai.shadowMode).toBe(true);
            expect(normal.quote.price.totalMinor).toBe(Math.round(p.totalPrice * 100));
            expect(p.fareBreakdown.extras).toMatchObject({ trafficMultiplier: 1, weatherMultiplier: 1, fuelMultiplier: 1, demandMultiplier: 1, timeMultiplier: 1 });
        }
        expect(sql('SELECT count(*) FROM audit_logs')).toBe('4');
        correct(s);
        expect(sql('SELECT count(*) FROM audit_logs')).toBe('4');
    }, 30000);
    it('NG payable quotes, multipliers, settings and all other-market rows remain identical', async () => {
        const settings = all('marketplace_settings'), ng = [];
        for (const traffic of [1, 9]) ng.push(await PricingService.resolvePrice(options('NG', id(91), 50, traffic)));
        correct(); refresh();
        for (const [n, traffic] of [1, 9].entries()) expect(await PricingService.resolvePrice(options('NG', id(91), 50, traffic))).toEqual(ng[n]);
        expect(all('marketplace_settings')).toEqual(settings);
        expect(all('market_pricing_strategies').filter((r: any) => r.country_code === 'FR')[0].maximum_surge_multiplier).toBe(2.7);
    }, 30000);
    it('a missing tenant setting inherits existing platform defaults so GB activation cannot change its NG quotes', async () => {
        sql(`DELETE FROM marketplace_settings WHERE tenant_id='${id(92)}' AND key='dynamic_pricing';
          INSERT INTO marketplace_settings(tenant_id,key,value) SELECT NULL,key,value #- '{markets,GB}'
          FROM marketplace_settings WHERE tenant_id='${id(91)}' AND key='dynamic_pricing';`);
        refresh();
        const globalBefore = all('marketplace_settings').filter((r: any) => r.tenant_id === null);
        const ng = await PricingService.resolvePrice(options('NG', id(92), 0));
        const lookup = activation.slice(activation.indexOf('CREATE TEMP TABLE gb_tenants'), activation.indexOf('-- P8 preconditions'));
        const setter = activation.slice(activation.indexOf('CREATE FUNCTION pg_temp.set_market_key'), activation.indexOf('-- P1 (+'));
        const settings = activation.slice(activation.indexOf('-- P6 PIN'), activation.indexOf('INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)'));
        sql('BEGIN;\n' + lookup + readFileSync(root + 'preserve-platform-defaults.sql', 'utf8') + setter + settings + '\nCOMMIT;');
        refresh();
        expect(await PricingService.resolvePrice(options('NG', id(92), 0))).toEqual(ng);
        expect(all('marketplace_settings').filter((r: any) => r.tenant_id === null)).toEqual(globalBefore);
        const own = all('marketplace_settings').find((r: any) => r.tenant_id === id(92) && r.key === 'dynamic_pricing');
        expect(own.value.maxSurge).toBe(2.4);
        expect(own.value.markets.GB.maxSurge).toBe(1.5);
        expect(sql("SELECT count(*) FROM audit_logs WHERE action='admin_develop_gb_setting_inheritance'")).toBe('1');
    }, 30000);
    it('real precedence is vehicle specificity before general city/zone, with exact market/service/currency and validity filtering', async () => {
        sql(`INSERT INTO market_pricing_strategies(id,country_code,currency,service_type,vehicle_class,market_city,zone_id,enabled,valid_until) VALUES
          ('${id(21)}','GB','GBP','ride','car',NULL,NULL,true,NULL),
          ('${id(22)}','GB','GBP','ride',NULL,'London','${id(99)}',true,NULL),
          ('${id(23)}','GB','GBP','delivery','car',NULL,NULL,true,NULL);
          UPDATE market_pricing_strategies SET enabled=true;`);
        refresh();
        const input: any = { countryCode: 'GB', currency: 'GBP', serviceType: 'ride', vehicleClass: 'car', marketCity: 'London', zoneId: id(99) };
        expect((await resolveMarketPricingStrategy(input))?.id).toBe(id(21));
        expect((await resolveMarketPricingStrategy({ ...input, tenantId: 'another-tenant' } as any))?.id).toBe(id(21));
        sql(`UPDATE market_pricing_strategies SET valid_until='2020-01-01' WHERE id='${id(21)}'`); refresh();
        expect((await resolveMarketPricingStrategy(input))?.id).toBe(id(22));
        expect(await resolveMarketPricingStrategy({ ...input, currency: 'NGN' })).toBeNull();
        expect(() => correct()).toThrow(/exactly the four/);
    }, 30000);
    it('stale snapshots, extra GB scopes, non-GB manifests and missing shadow mode are refused atomically', () => {
        const s = snapshot(); sql(`UPDATE market_pricing_strategies SET commission_percent=18 WHERE id='${id(1)}'`);
        const before = all('market_pricing_strategies');
        expect(() => correct(s)).toThrow(/changed since snapshot/); expect(all('market_pricing_strategies')).toEqual(before);
        expect(() => correct('[]')).toThrow(/exactly the four/);
        sql("UPDATE pricing_markets SET shadow_mode_enabled=false WHERE country_code='GB'");
        expect(() => correct()).toThrow(/shadow mode/);
        expect(sql('SELECT count(*) FROM audit_logs')).toBe('0');
    }, 30000);
    it('an unexpected timestamp/field mutation rolls back the entire correction and audits', () => {
        sql("CREATE FUNCTION p8_unexpected() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at:=now(); RETURN NEW; END $$; CREATE TRIGGER p8_unexpected BEFORE UPDATE ON market_pricing_strategies FOR EACH ROW EXECUTE FUNCTION p8_unexpected()");
        const before = all('market_pricing_strategies');
        try { expect(() => correct()).toThrow(/unrelated strategy fields/); expect(all('market_pricing_strategies')).toEqual(before); expect(sql('SELECT count(*) FROM audit_logs')).toBe('0'); }
        finally { sql('DROP TRIGGER p8_unexpected ON market_pricing_strategies; DROP FUNCTION p8_unexpected()'); }
    }, 30000);
    it('preflight reports all simultaneous conflicts, missing schema/functions and NULL campaign fields, without business writes', () => {
        sql(`UPDATE pricing_markets SET shadow_mode_enabled=false WHERE country_code='GB';
          UPDATE marketplace_settings SET value='false' WHERE key='market_pricing_shadow_mode';
          INSERT INTO campaigns(tenant_id,code,kind,market_code,currency_code,service_slug,audience,funding_party,budget_minor,qualification,per_user_cap,stacking,referral_reward_bps,value_type,value)
          VALUES('${id(91)}','FIRST5GB','customer_discount','GB','GBP','ride','customer','platform',50000,'{"firstBookingOnly":true,"max_discount_minor":500,"min_qualifying_fare_minor":800}',1,'exclusive',500,NULL,NULL);`);
        const before = all('marketplace_settings');
        const output = sql(readFileSync(root + 'activation-preflight.sql', 'utf8'));
        const report = JSON.parse(output.split('\n').find(l => l.startsWith('ACTIVATION_PREFLIGHT_JSON='))!.split('ACTIVATION_PREFLIGHT_JSON=')[1]);
        const checks = Object.fromEntries(report.checks.map((r: any) => [r.code, r.status]));
        expect(checks).toMatchObject({ release2_referral: 'BLOCK', release_functions: 'BLOCK', ai_market_shadow: 'BLOCK',
            market_intelligence_shadow: 'BLOCK', campaign_terms: 'BLOCK', p8_strategy_overrides: 'CORRECTABLE', gb_profiles: 'PASS' });
        expect(report.blocks).toBeGreaterThanOrEqual(5);
        expect(all('marketplace_settings')).toEqual(before);
        expect(sql('SELECT count(*) FROM audit_logs')).toBe('0');
    }, 30000);
});
