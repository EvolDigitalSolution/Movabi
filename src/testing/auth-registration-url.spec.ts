import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveExternalSupabaseUrl } from '../../server/services/supabase.service';

const authRoutes = readFileSync(resolve(process.cwd(), 'server/routes/auth.routes.ts'), 'utf8');
const supabaseService = readFileSync(resolve(process.cwd(), 'server/services/supabase.service.ts'), 'utf8');

describe('resolveExternalSupabaseUrl', () => {
    it('prefers API_EXTERNAL_URL', () => {
        expect(resolveExternalSupabaseUrl({ API_EXTERNAL_URL: 'https://movabi-supabase.apps.evolsolution.com' }))
            .toBe('https://movabi-supabase.apps.evolsolution.com');
    });

    it('falls back to MOVABI_SUPABASE_DOMAIN (as https)', () => {
        expect(resolveExternalSupabaseUrl({ MOVABI_SUPABASE_DOMAIN: 'movabi-supabase.apps.evolsolution.com' }))
            .toBe('https://movabi-supabase.apps.evolsolution.com');
    });

    it('uses SUPABASE_URL only in non-production', () => {
        expect(resolveExternalSupabaseUrl({ NODE_ENV: 'development', SUPABASE_URL: 'https://movabi-supabase.apps.evolsolution.com' }))
            .toBe('https://movabi-supabase.apps.evolsolution.com');
    });

    it('fails safe in production without an external URL (never the private Kong hostname)', () => {
        expect(() => resolveExternalSupabaseUrl({ NODE_ENV: 'production', SUPABASE_URL: 'http://movabi-supabase-kong:8000' }))
            .toThrow(/API_EXTERNAL_URL/);
    });

    it('uses API_EXTERNAL_URL in production, ignoring the internal SUPABASE_URL', () => {
        expect(resolveExternalSupabaseUrl({
            NODE_ENV: 'production',
            API_EXTERNAL_URL: 'https://movabi-supabase.apps.evolsolution.com',
            SUPABASE_URL: 'http://movabi-supabase-kong:8000'
        })).toBe('https://movabi-supabase.apps.evolsolution.com');
    });
});

describe('registration auth client wiring', () => {
    it('register signUp uses the external registration client', () => {
        expect(authRoutes).toContain('getSupabaseAuthRegistrationClient().auth.signUp');
        expect(authRoutes).not.toContain('supabaseAdmin.auth.signUp');
    });

    it('registration_otps still uses the normal supabaseAdmin', () => {
        expect(authRoutes).toContain("supabaseAdmin.from('registration_otps')");
    });

    it('preserves the safe emailRedirectTo validation', () => {
        expect(authRoutes).toContain('safeRedirect');
        expect(authRoutes).toContain('com\\.movabi\\.app');
    });

    it('registration client uses service role key with non-persistent auth options', () => {
        expect(supabaseService).toContain('getSupabaseAuthRegistrationClient');
        expect(supabaseService).toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(supabaseService).toContain('autoRefreshToken: false');
        expect(supabaseService).toContain('persistSession: false');
    });

    it('normal supabaseAdmin remains based on SUPABASE_URL', () => {
        expect(supabaseService).toContain('const supabaseUrl = process.env.SUPABASE_URL');
    });
});
