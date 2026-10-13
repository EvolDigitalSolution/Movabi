import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { customerDisplayName } from '../app/shared/utils/customer-display';
import { NetworkService } from '../app/core/services/network/network.service';
const message = (error: unknown, online = true) => NetworkService.prototype.normalizeError.call({ isOnline: online } as NetworkService, error);
describe('customer display name', () => {
    it('uses the full account name', () => expect(customerDisplayName({ full_name: 'CCC Holy Throne Of God' })).toBe('CCC Holy Throne Of God'));
    it('joins first and last names', () => expect(customerDisplayName({ first_name: 'Philip', last_name: 'Albert' })).toBe('Philip Albert'));
    it('handles missing or blank fields', () => expect(customerDisplayName({ full_name: ' ', display_name: 'Customer Name' })).toBe('Customer Name'));
    it('does not use phone numbers as names', () => expect(customerDisplayName({ phone: '+440000000' })).toBe('Customer'));
});
describe('network failure messages', () => {
    it('explains an offline connection', () => expect(message({}, false)).toContain('No internet'));
    it('explains an unreachable API', () => expect(message({ status: 0 })).toContain('Network error'));
    it('preserves the business error from a reachable API', () => expect(message({ name: 'HttpErrorResponse', status: 400, error: { error: 'Customer authorization expired' } })).toBe('Customer authorization expired'));
    it('explains timeout and server outage', () => {
        expect(message({ name: 'TimeoutError' })).toContain('timed out');
        expect(message({ status: 503 })).toContain('temporarily unavailable');
    });
});

describe('shopping request stage alignment', () => {
    const sql = readFileSync('supabase/migrations/20261242300000_shopping_request_stage_alignment.sql', 'utf8');
    it('allows an authorized customer-bound job without allowing delivered or completed stages', () => {
        const guard = sql.split("IF coalesce(j.payment_status,'')")[1].split('THEN')[0];
        expect(guard).toContain("'collected','en_route_to_customer'");
        expect(guard).not.toContain("'delivered'");
        expect(guard).not.toContain("'completed'");
        expect(guard).toContain("'wallet_funded','authorized'");
    });
    it('retains ownership, idempotency and greater-budget validation', () => {
        expect(sql).toContain('auth.uid() IS DISTINCT FROM j.driver_id');
        expect(sql).toContain('f.requested_over_budget_amount=round(p_amount,2)');
        expect(sql).toContain('round(p_amount,2)<=f.item_budget');
    });
});
