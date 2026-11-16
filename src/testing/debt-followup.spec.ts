import { describe, expect, it, vi } from 'vitest';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
import { DebtFollowupService } from '../../server/services/debt-followup.service';

const env = { VAYDU_DEPLOYMENT_ENV: 'develop', VAYDU_DEBT_FOLLOWUPS: 'true' };
describe('P3 durable debt worker', () => {
    it('does nothing without explicit develop environment AND enable flag', async () => {
        const rpc = vi.fn();
        for (const config of [{}, { VAYDU_DEBT_FOLLOWUPS: 'true' }, { ...env, VAYDU_DEPLOYMENT_ENV: 'production' }, { ...env, VAYDU_DEBT_FOLLOWUPS: 'false' }]) {
            const svc = new DebtFollowupService({ env: config, db: { rpc } });
            expect(svc.start()).toBe(false);
            expect(await svc.runOnce()).toEqual({ skipped: 'disabled' });
        }
        expect(rpc).not.toHaveBeenCalled();
    });
    it('delegates age, scope, deduplication and notification persistence to one DB transaction', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { reminders: 2, reviews: 1 }, error: null });
        expect(await new DebtFollowupService({ env, db: { rpc } }).runOnce()).toEqual({ reminders: 2, reviews: 1 });
        expect(rpc).toHaveBeenCalledWith('process_overdue_customer_debts', { p_limit: 100 });
    });
    it('a failed transaction is retried; the worker does not pretend it delivered reminders', async () => {
        const rpc = vi.fn().mockResolvedValueOnce({ error: { message: 'unavailable' } })
            .mockResolvedValueOnce({ data: { reminders: 1, reviews: 0 } });
        const svc = new DebtFollowupService({ env, db: { rpc } });
        await expect(svc.runOnce()).rejects.toThrow('transaction failed');
        expect(await svc.runOnce()).toEqual({ reminders: 1, reviews: 0 });
    });
    it('prevents overlapping runs, and releases its local guard after completion', async () => {
        let release: (value: any) => void = () => {};
        const rpc = vi.fn(() => new Promise(resolve => { release = resolve; }));
        const svc = new DebtFollowupService({ env, db: { rpc } });
        const first = svc.runOnce();
        expect(await svc.runOnce()).toEqual({ skipped: 'running' });
        release({ data: { reminders: 0, reviews: 0 } });
        await first;
        expect(rpc).toHaveBeenCalledTimes(1);
    });
    it('rejects malformed RPC results and allows the next run', async () => {
        const rpc = vi.fn().mockResolvedValueOnce({ data: { reminders: '1', reviews: -1 } })
            .mockResolvedValueOnce({ data: { reminders: 0, reviews: 0 } });
        const svc = new DebtFollowupService({ env, db: { rpc } });
        await expect(svc.runOnce()).rejects.toThrow('result invalid');
        expect(await svc.runOnce()).toEqual({ reminders: 0, reviews: 0 });
    });
});
