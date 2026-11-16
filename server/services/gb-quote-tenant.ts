/** Activated signed-in GB quotes derive tenant from the session/profile. Other-country,
 * anonymous and pre-activation routing retain the existing context. */
export class QuoteTenantContextError extends Error {
    constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
}
export async function resolveGbQuoteTenant(input: {
    countryCode: string; authorization?: unknown; legacyTenantId?: string | null;
    /** Only the identity from the route's existing server auth check. */
    authenticatedUserId?: string | null;
}, db: any): Promise<string | null> {
    if (String(input.countryCode).toUpperCase() !== 'GB') return input.legacyTenantId || null;
    const bearer = String(input.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer && !input.authenticatedUserId) return input.legacyTenantId || null;
    let userId = input.authenticatedUserId;
    if (!userId) {
        const auth = await db.auth.getUser(bearer);
        if (auth.error || !auth.data?.user?.id) throw new QuoteTenantContextError('Please sign in again.', 401, 'QUOTE_SESSION_INVALID');
        userId = auth.data.user.id;
    }
    const profile = await db.from('profiles').select('tenant_id,role,registration_country_code,country_code').eq('id', userId).maybeSingle();
    if (profile.error) throw new QuoteTenantContextError('Your quote profile is temporarily unavailable.', 503, 'QUOTE_PROFILE_UNAVAILABLE');
    if (!profile.data) throw new QuoteTenantContextError('Your booking profile is not ready.', 409, 'QUOTE_PROFILE_REQUIRED');
    const p = profile.data;
    const market = String(p.registration_country_code?.trim() || p.country_code?.trim() || '').toUpperCase();
    if (market !== 'GB' || !['customer', 'driver'].includes(p.role)) return input.legacyTenantId || null;
    if (!p.tenant_id) throw new QuoteTenantContextError('Your booking tenant is not ready.', 409, 'QUOTE_TENANT_REQUIRED');
    // The paired API can deploy safely before the data transaction. Binding activates only
    // with the approved per-tenant GB switch committed atomically with P8; no platform switch.
    const binding = await db.from('marketplace_settings').select('value').eq('tenant_id', p.tenant_id)
        .eq('key', 'quote_tenant_binding').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (binding.error) throw new QuoteTenantContextError('Your quote scope is temporarily unavailable.', 503, 'QUOTE_SCOPE_UNAVAILABLE');
    if (binding.data?.value?.markets?.GB?.enabled !== true) return input.legacyTenantId || null;
    return String(p.tenant_id);
}
