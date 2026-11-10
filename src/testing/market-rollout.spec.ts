import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    buildMarketScopePayload,
    marketScopeLabel,
    normalizeMarketDate,
    toDateTimeLocalValue
} from '../app/apps/admin/features/marketplace/market-rollout.payload';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const baseForm = (overrides: Record<string, unknown> = {}) => ({
    country_code: 'NG',
    market_city: null as string | null,
    zone_id: null as string | null,
    launch_status: 'live' as const,
    customer_app_enabled: true,
    customer_registration_enabled: true,
    driver_registration_enabled: true,
    driver_online_enabled: true,
    quote_enabled: true,
    booking_enabled: true,
    payment_enabled: true,
    waiting_list_enabled: true,
    supported_currency: 'NGN' as string | null,
    timezone: 'Africa/Lagos' as string | null,
    unavailable_title: 'Nigeria Operations / Live' as string | null,
    unavailable_message: 'This is coming soon' as string | null,
    valid_from: null as string | null,
    valid_until: null as string | null,
    enabled: true,
    ...overrides
});

describe('Admin Market Rollout create/update', () => {
    const component = read('src/app/apps/admin/features/marketplace/market-rollout.component.ts');
    const service = read('src/app/apps/admin/services/admin-market-availability.service.ts');

    it('labels the save action by mode (create vs update)', () => {
        expect(component).toContain("form()!.id ? 'Update scope' : 'Create scope'");
        expect(component).not.toContain('Save existing scope by ID');
    });

    it('New scope clears any stale edit id so the create path is used', () => {
        const createBlock = component.slice(component.indexOf('create(): void {'), component.indexOf('cancel(): void {'));
        expect(createBlock).toContain('this.form.set({');
        expect(createBlock).not.toMatch(/\bid:/);
    });

    it('Edit preserves the existing scope id for the update path', () => {
        const editBlock = component.slice(component.indexOf('edit(row: MarketAvailabilityRow)'), component.indexOf('create(): void {'));
        expect(editBlock).toContain('...form');
        expect(editBlock).toContain('this.form.set({');
    });

    it('service uses POST for create and PUT for update', () => {
        expect(service).toContain('if (form.id)');
        expect(service).toContain('this.http.put<MarketAvailabilityRow>');
        expect(service).toContain("/api/markets/admin/${encodeURIComponent(id)}");
        expect(service).toContain('this.http.post<MarketAvailabilityRow>');
        expect(service).toContain("'/api/markets/admin'");
    });

    it('invalid required fields produce visible validation feedback', () => {
        expect(component).toContain('country.length !== 2');
        expect(component).toContain('Enter a valid 2-letter country code before saving.');
    });

    it('API failure produces visible feedback (not a silent no-op)', () => {
        const saveBlock = component.slice(component.indexOf('async save(): Promise<void>'));
        expect(saveBlock).toContain('try {');
        expect(saveBlock).toContain('catch (error)');
        expect(saveBlock).toContain('this.showToast(');
        expect(component).toContain('describeError');
    });

    it('successful create/update closes the form and reloads the list', () => {
        const saveBlock = component.slice(component.indexOf('async save(): Promise<void>'));
        expect(saveBlock).toContain('this.form.set(null)');
        expect(saveBlock).toContain('await this.load()');
        expect(saveBlock).toContain("'Scope created.'");
        expect(saveBlock).toContain("'Scope updated.'");
    });

    it('action labels cannot clip', () => {
        expect(component).toContain('shrink-0 whitespace-nowrap');
    });

    it('never binds human-readable text to zone_id (no free-text zone input)', () => {
        expect(component).not.toContain('name="zone"');
        expect(component).not.toContain('form()!.zone_id');
        expect(component).toContain('readonly');
    });
});

describe('market rollout payload validity', () => {
    it('country-wide scope sends city=null and zone_id=null', () => {
        const payload = buildMarketScopePayload(baseForm() as any);
        expect(payload.country_code).toBe('NG');
        expect(payload.market_city).toBeNull();
        expect(payload.zone_id).toBeNull();
    });

    it('city-wide / all-zones scope sends the city and zone_id=null', () => {
        const payload = buildMarketScopePayload(baseForm({ market_city: 'Lagos' }) as any);
        expect(payload.country_code).toBe('NG');
        expect(payload.market_city).toBe('Lagos');
        expect(payload.zone_id).toBeNull();
    });

    it('human-readable zone text is never sent as zone_id', () => {
        const payload = buildMarketScopePayload(baseForm({ market_city: 'Lagos', zone_id: 'Lagos' }) as any);
        expect(payload.zone_id).toBeNull();
        expect(JSON.stringify(payload)).not.toContain('"zone_id":"Lagos"');
    });

    it('no top-level id means create; an id means update', () => {
        expect(buildMarketScopePayload(baseForm() as any).id).toBeUndefined();
        expect(buildMarketScopePayload(baseForm({ id: 'scope-1' }) as any).id).toBe('scope-1');
    });

    it('empty optional dates serialise to null (never an invalid date string)', () => {
        const payload = buildMarketScopePayload(baseForm({ valid_from: '', valid_until: null }) as any);
        expect(payload.valid_from).toBeNull();
        expect(payload.valid_until).toBeNull();
        expect(normalizeMarketDate('')).toBeNull();
        expect(normalizeMarketDate('   ')).toBeNull();
        expect(normalizeMarketDate(undefined)).toBeNull();
    });

    it('valid dates serialise to ISO timestamps', () => {
        expect(normalizeMarketDate('2026-01-01T10:00')).toBe(new Date('2026-01-01T10:00').toISOString());
        expect(normalizeMarketDate('not-a-date')).toBeNull();
    });

    it('edit date conversion produces a datetime-local value', () => {
        const local = toDateTimeLocalValue('2026-01-01T10:00:00.000Z');
        expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(toDateTimeLocalValue(null)).toBeNull();
    });

    it('normalises country/currency and blanks optional strings', () => {
        const payload = buildMarketScopePayload(baseForm({
            country_code: ' ng ', supported_currency: 'ngn', timezone: '  ', unavailable_title: '', unavailable_message: ' hi '
        }) as any);
        expect(payload.country_code).toBe('NG');
        expect(payload.supported_currency).toBe('NGN');
        expect(payload.timezone).toBeNull();
        expect(payload.unavailable_title).toBeNull();
        expect(payload.unavailable_message).toBe('hi');
    });

    it('scope label reflects country vs city scope', () => {
        expect(marketScopeLabel(null)).toContain('Country-wide');
        expect(marketScopeLabel('Lagos')).toContain('City-wide');
    });
});
