import { describe, expect, it, vi } from 'vitest';
import { resolveGbQuoteTenant } from '../../server/services/gb-quote-tenant';
function fixture(over: any = {}) {
    const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(async () =>
        ({ data: { tenant_id: 'native-gb', role: 'customer', registration_country_code: '', country_code: 'GB', ...over }, error: null })) };
    const binding: any = { select: () => binding, eq: () => binding, order: () => binding, limit: () => binding,
        maybeSingle: vi.fn(async () => ({ data: { value: { markets: { GB: { enabled: true } } } }, error: null })) };
    const db = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'signed-user' } }, error: null })) }, from: vi.fn((t: string) => t === 'profiles' ? query : binding) };
    return { db, query, binding };
}
describe('GB quote tenant binding without changing foreign market routing', () => {
    it.each(['', '  ', null])('uses the signed-in GB profile with blank registration %s and ignores body tenant', async registration => {
        const { db, query } = fixture({ registration_country_code: registration });
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good', legacyTenantId: 'victim' }, db)).toBe('native-gb');
        expect(db.auth.getUser).toHaveBeenCalledWith('good'); expect(query.eq).toHaveBeenCalledWith('id', 'signed-user');
    });
    it('reuses only the existing server-validated identity, never another auth call', async () => {
        const { db, query } = fixture({ role: 'driver' });
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', authenticatedUserId: 'already-validated' }, db)).toBe('native-gb');
        expect(db.auth.getUser).not.toHaveBeenCalled(); expect(query.eq).toHaveBeenCalledWith('id', 'already-validated');
    });
    it('preserves NG/other-country legacy tenant routing, without even looking up a GB profile', async () => {
        const { db } = fixture();
        expect(await resolveGbQuoteTenant({ countryCode: 'NG', authorization: 'Bearer bad', legacyTenantId: 'ng-legacy' }, db)).toBe('ng-legacy');
        expect(await resolveGbQuoteTenant({ countryCode: 'FR' }, db)).toBeNull();
        expect(db.auth.getUser).not.toHaveBeenCalled(); expect(db.from).not.toHaveBeenCalled();
    });
    it('does not bind foreign-registered profiles and retains anonymous legacy quote context', async () => {
        const { db } = fixture({ registration_country_code: 'NG', country_code: 'GB' });
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good' }, db)).toBeNull();
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', legacyTenantId: 'old-anonymous-context' }, db)).toBe('old-anonymous-context');
    });
    it('a pre-deployed API retains the old quote context until the atomic GB data switch is enabled', async () => {
        const { db, binding } = fixture(); binding.maybeSingle.mockResolvedValue({ data: null, error: null });
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good' }, db)).toBeNull();
        expect(await resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good', legacyTenantId: 'previous-explicit' }, db)).toBe('previous-explicit');
    });
    it('invalid sessions and missing tenant/profile fail closed instead of mispricing under a default tenant', async () => {
        const bad = fixture(); bad.db.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } } as any);
        await expect(resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer bad' }, bad.db)).rejects.toMatchObject({ status: 401 });
        const missing = fixture({ tenant_id: null });
        await expect(resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good' }, missing.db)).rejects.toMatchObject({ status: 409 });
        const failed = fixture(); failed.query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'db unavailable' } });
        await expect(resolveGbQuoteTenant({ countryCode: 'GB', authorization: 'Bearer good' }, failed.db)).rejects.toMatchObject({ status: 503 });
    });
});
