/**
 * PHASE 1 — REGISTRATION MARKET ELIGIBILITY AUTHORITY.
 *
 * Proves the durable distinction between AUTHENTICATED and
 * REGISTRATION-ELIGIBLE, that raw auth metadata can never activate an identity,
 * that existing production profiles are grandfathered, and that the separate
 * customer_registration / driver_registration capabilities are both enforced.
 *
 * Source-assertion guard (the repository's established pattern) over the
 * migration and the server/client authority surfaces.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const MIG = read('supabase/migrations/20261239000000_registration_market_eligibility.sql');
const SVC = read('server/services/registration-eligibility.service.ts');
const AUTH = read('server/routes/auth.routes.ts');
const MKT = read('server/routes/market-availability.routes.ts');
const ROLE = read('src/app/apps/mobile/features/auth/role-selection.page.ts');

/** Executable statements only (the header comment intentionally mentions 'GB'). */
const MIG_SQL = MIG.slice(MIG.indexOf('ALTER TABLE public.profiles'));
const HANDLE = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_user'));

describe('1-2. Grandfathering and future-profile default', () => {
  it('grandfathers every existing profile deterministically', () => {
    expect(MIG_SQL).toContain('UPDATE public.profiles');
    expect(MIG_SQL).toMatch(/SET registration_activated_at = COALESCE\(created_at, now\(\)\)/);
    expect(MIG_SQL).toMatch(/WHERE registration_activated_at IS NULL/);
  });

  it('grandfathering uses no location/IP/GPS/onboarding input', () => {
    const backfill = MIG_SQL.slice(MIG_SQL.indexOf('UPDATE public.profiles'), MIG_SQL.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(backfill).not.toMatch(/ip|geo|latitude|longitude|address|onboarding/i);
  });

  it('grandfathering runs before the new-profile trigger is installed', () => {
    expect(MIG.indexOf('UPDATE public.profiles')).toBeLessThan(MIG.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_user'));
  });

  it('future profiles are created registration-PENDING', () => {
    expect(HANDLE).toContain('registration_activated_at');
    expect(HANDLE).toContain('NULL                  -- ALWAYS pending; metadata cannot self-activate');
  });
});

describe('3-5. Metadata is never authority', () => {
  it('raw metadata can never set the activation marker', () => {
    expect(MIG).not.toMatch(/registration_activated_at\s*[,=:][^,)\n]*raw_user_meta_data/);
    expect(HANDLE).not.toMatch(/registration_activated[^,)\n]*raw_user_meta_data/);
  });

  it('only the server service writes the activation timestamp', () => {
    expect(SVC).toContain('registration_activated_at: new Date().toISOString()');
    expect(AUTH).not.toMatch(/registration_activated_at\s*:/);
    expect(MKT).not.toMatch(/registration_activated_at\s*:/);
  });

  it('a missing country does not silently become GB', () => {
    expect(MIG_SQL).toContain('ALTER TABLE public.profiles ALTER COLUMN country_code DROP DEFAULT;');
    expect(MIG_SQL).toContain('ALTER TABLE public.profiles ALTER COLUMN country_code DROP NOT NULL;');
    expect(MIG_SQL).not.toMatch(/country_code\s*=\s*'GB'/i);
    expect(MIG_SQL).not.toMatch(/country_code\s+text\s+DEFAULT\s+'GB'/i);
    expect(HANDLE).toContain('NULL,                 -- never fabricate a country (no silent \'GB\')');
  });

  it('metadata only seeds pending registration context', () => {
    expect(HANDLE).toContain("raw_user_meta_data->>'registration_country_code'");
    expect(HANDLE).toContain("raw_user_meta_data->>'registration_market_city'");
    expect(HANDLE).toContain('NULLIF(upper(trim(');
  });
});

describe('6-7. Email registration', () => {
  it('validates customer_registration BEFORE auth.users creation', () => {
    expect(AUTH.indexOf('requireCapability')).toBeGreaterThan(-1);
    expect(AUTH.indexOf('requireCapability')).toBeLessThan(AUTH.indexOf('auth.signUp'));
  });

  it('activates the new profile through server authority after signUp', () => {
    expect(AUTH).toContain('RegistrationEligibilityService.activate(data.user.id');
    expect(AUTH.indexOf('auth.signUp')).toBeLessThan(AUTH.indexOf('RegistrationEligibilityService.activate'));
  });

  it('never fails auth creation when activation cannot be recorded', () => {
    expect(AUTH).toContain('registration activation failed');
    expect(AUTH).toContain('RegistrationEligibilityService.getState(data.user.id)');
  });
});

describe('8-12. Post-OAuth / direct-auth eligibility endpoint', () => {
  it('exposes an authenticated eligibility endpoint', () => {
    expect(MKT).toContain("router.post('/registration-eligibility'");
    expect(MKT).toContain('RegistrationEligibilityService.ensureEligibility(');
  });

  it('requires authentication and takes the id only from the session', () => {
    const route = MKT.slice(MKT.indexOf("router.post('/registration-eligibility'"));
    expect(route).toContain('const userId=await authUser(req)');
    expect(route).toContain('401');
    expect(route).not.toMatch(/body\?\.userId|body\.userId|body\?\.activated|body\.activated/);
  });

  it('validates the market capability before activating', () => {
    expect(SVC).toContain('MarketAvailabilityService.requireCapability({');
    expect(SVC.indexOf('requireCapability')).toBeLessThan(SVC.indexOf('return this.activate('));
  });

  it('activation is idempotent', () => {
    expect(SVC).toContain('if (existing.activated) return existing;');
    expect((SVC.match(/if \(existing\.activated\) return existing;/g) || []).length).toBe(2);
  });

  it('an activated established user is never re-gated by current location', () => {
    expect(SVC).not.toMatch(/geolocation|latitude|longitude|req\.ip|x-forwarded-for|country header/i);
    expect(MKT).toContain("router.get('/registration-status'");
    expect(MKT).toContain('return res.json(state);');
    expect(MKT).toContain('const userId=await authUser(req);');
  });

  it('exposes a status capability', () => {
    expect(MKT).toContain("router.get('/registration-status'");
    expect(SVC).toContain('static async getState');
  });
});

describe('13-16. Role selection authority and capability separation', () => {
  it('keeps customer_registration and driver_registration distinct', () => {
    expect(AUTH).toContain("const capability = role === 'driver' ? 'driver_registration' : 'customer_registration';");
  });

  it('enforces the role capability server-side before persisting the role', () => {
    const route = AUTH.slice(AUTH.indexOf("router.post('/select-role'"));
    expect(route).toContain('await MarketAvailabilityService.requireCapability({');
    expect(route.indexOf('requireCapability')).toBeLessThan(route.indexOf("update({ role })"));
  });

  it('requires registration activation before a role can be chosen', () => {
    expect(AUTH).toContain('REGISTRATION_PENDING');
  });

  it('refuses to change an established role', () => {
    expect(AUTH).toContain('return res.json({ role: existingRole, changed: false, registration });');
  });

  it('the client no longer writes the role directly', () => {
    expect(ROLE).toContain('await this.authService.selectRole(role);');
    expect(ROLE).not.toContain('updateProfile(user.id, { role })');
  });
});

describe('17-20. Preserved trigger behaviour and hardening', () => {
  it('still establishes tenant + tenant_users state', () => {
    expect(HANDLE).toContain("WHERE slug = 'movabi-global'");
    expect(HANDLE).toContain('INSERT INTO public.tenant_users');
    expect(HANDLE).toContain('SECURITY DEFINER');
  });

  it('keeps first-time role selection deferred (role NULL, not customer)', () => {
    expect(HANDLE).toContain('NULL,                 -- first-time role selection happens later');
    expect(HANDLE).not.toContain("COALESCE(new.raw_user_meta_data->>'role', 'customer')");
  });

  it('does not disturb the wallet trigger or ownership guards', () => {
    expect(MIG).not.toContain('handle_new_user_wallet');
    expect(MIG).not.toMatch(/DROP TRIGGER.*trg_profiles_ownership_guard/);
    expect(MIG).not.toMatch(/ALTER.*trg_profiles_ownership_guard/);
  });

  it('does not weaken unrelated profile constraints', () => {
    expect(MIG).not.toMatch(/DROP CONSTRAINT|profiles_pricing_plan_check/);
  });

  it('uses the service-role/admin client for activation writes', () => {
    expect(SVC).toContain("import { supabaseAdmin } from './supabase.service';");
    expect(SVC).toContain('supabaseAdmin');
    expect(SVC).not.toMatch(/from\('profiles'\)[\s\S]{0,80}\.insert\(/);
  });

  it('direct profile manipulation cannot manufacture activation (server-only guard)', () => {
    expect(MIG).toContain('enforce_registration_authority_guard');
    expect(MIG).toContain('trg_registration_authority_guard');
    expect(MIG).toContain('BEFORE UPDATE OF registration_activated_at, registration_country_code, registration_market_city');
    expect(MIG).toContain("v_role IS NULL OR v_role = 'service_role'");
    expect(MIG).toContain("ERRCODE = '42501', CONSTRAINT = 'trg_registration_authority_guard'");
  });
});
