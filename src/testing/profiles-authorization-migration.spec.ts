import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261229000000_profiles_authorization_hardening.sql'), 'utf8');
const identityService = readFileSync(resolve(process.cwd(), 'server/services/driver-identity-editability.service.ts'), 'utf8');
const handleNewUser = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260407000000_handle_new_user.sql'), 'utf8');
const adminRoutes = readFileSync(resolve(process.cwd(), 'server/routes/admin.routes.ts'), 'utf8');
const adminService = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/services/admin.service.ts'), 'utf8');

describe('profiles authorization hardening migration', () => {
    it('1. revokes anon write authority on profiles', () => {
        expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.profiles FROM anon;');
    });

    it('2. retains anon SELECT on profiles', () => {
        expect(migration).not.toMatch(/REVOKE\s+SELECT[^;]*public\.profiles[^;]*FROM anon/i);
    });

    it('3. uses auth.role() for trusted-role detection', () => {
        expect(migration).toContain('auth.role()');
        expect(migration).toContain("v_role = 'service_role'");
    });

    it('4. blocks all three protected identity columns with IS DISTINCT FROM', () => {
        expect(migration).toContain('NEW.full_name IS DISTINCT FROM OLD.full_name');
        expect(migration).toContain('NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth');
        expect(migration).toContain('NEW.country_code IS DISTINCT FROM OLD.country_code');
    });

    it('5. uses the exact verified-driver predicate from DriverIdentityEditabilityService', () => {
        expect(identityService).toContain('profile.driver_review_status||profile.verification_status');
        expect(identityService).toContain("profile.is_verified===true||status==='approved'");
        expect(migration).toContain("lower(COALESCE(NULLIF(OLD.driver_review_status, ''),");
        expect(migration).toContain("NULLIF(OLD.verification_status, ''), '')) = 'approved'");
    });

    it('6. permits no-op updates and does not enable RLS', () => {
        expect(migration).toContain('IS DISTINCT FROM');
        expect(migration).not.toContain('ENABLE ROW LEVEL SECURITY');
    });

    it('7. profile bootstrap is SECURITY DEFINER, so anon revoke + ownership guard are safe', () => {
        expect(handleNewUser).toContain('SECURITY DEFINER');
        expect(handleNewUser).toContain('INSERT INTO public.profiles');
    });

    it('8. adds an authenticated ownership guard (INSERT/UPDATE/DELETE own-row)', () => {
        expect(migration).toContain('enforce_profiles_ownership_guard');
        expect(migration).toContain('trg_profiles_ownership_guard_insert');
        expect(migration).toContain('trg_profiles_ownership_guard_update');
        expect(migration).toContain('trg_profiles_ownership_guard_delete');
        expect(migration).toContain('NEW.id IS DISTINCT FROM v_uid');
        expect(migration).toContain('OLD.id IS DISTINCT FROM v_uid');
        expect(migration).toContain('auth.uid()');
    });
});

describe('admin account-status server boundary', () => {
    it('9. moves the Admin cross-row write behind a requireAdmin service_role route', () => {
        expect(adminRoutes).toContain("router.post('/account-status', requireAdmin");
        expect(adminRoutes).toContain('moderated_by: adminUserId');
        expect(adminRoutes).toContain('supabaseAdmin');
        // The acting admin must be server-derived, never trusted from the body.
        expect(adminRoutes).toContain('adminUserId = (req as any).adminUserId');
    });

    it('10. validates the status against the moderation whitelist', () => {
        expect(adminRoutes).toContain("allowedStatuses = ['active', 'closure_requested', 'closed', 'reinstated', 'suspended', 'banned', 'disabled']");
    });

    it('11. Admin UI no longer performs a direct cross-row profile write', () => {
        expect(adminService).toContain('/api/admin/account-status');
        expect(adminService).not.toContain("this.supabase.from('profiles').update(update).eq('id', userId)");
    });
});
