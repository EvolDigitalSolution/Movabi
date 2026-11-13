import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    secret: null as any,
    policy: 'required' as string | null,
    attemptVerdict: 'ok' as string,
    overrideError: false,
};

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        // job_completion_secrets: .select().eq().maybeSingle(); driver_pin_policies: .select().eq().eq().maybeSingle().
        from: (table: string) => table === 'driver_pin_policies'
            ? ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => state.overrideError
                ? ({ data: null, error: { message: 'boom' } }) : ({ data: state.policy ? { policy: state.policy } : null, error: null }) }) }) }) })
            : ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.secret, error: null }) }) }) }),
        rpc: async (fn: string, _args: any) => {
            if (fn === 'effective_completion_pin_policy') return { data: state.policy, error: null };
            if (fn === 'record_pin_attempt') return { data: state.attemptVerdict, error: null };
            return { data: null, error: null };
        },
    },
}));

import { LogisticsService } from '../../server/services/logistics.service';
const verify = (job: any, pin?: string) => (LogisticsService as any).assertCompletionPin(job, pin);

const JOB = { id: 'j1', driver_id: 'd1', tenant_id: 't1', metadata: { completion_pin_required: true } };

describe('completion PIN policy (verifyCompletionPin)', () => {
    beforeEach(() => { state.secret = { completion_pin: '1234' }; state.policy = 'required'; state.attemptVerdict = 'ok'; state.overrideError = false; });

    it('required: correct PIN passes through record_pin_attempt', async () => {
        const meta = await verify(JOB, '1234');
        expect(meta).toBeTruthy();
    });

    it('required: missing PIN throws', async () => {
        await expect(verify(JOB, undefined)).rejects.toThrow(/required/i);
    });

    it('disabled: skips verification entirely — no PIN needed', async () => {
        state.policy = 'disabled';
        const meta = await verify(JOB, undefined);
        expect(meta).toBeTruthy();
    });

    it('optional: verifies when provided, tolerates absence', async () => {
        state.policy = 'optional';
        expect(await verify(JOB, undefined)).toBeTruthy();
        expect(await verify(JOB, '1234')).toBeTruthy();
    });

    it('locked after attempts: throws with retry-later message', async () => {
        state.attemptVerdict = 'locked';
        await expect(verify(JOB, '1234')).rejects.toThrow(/too many/i);
    });

    it('replay: already-used PIN throws', async () => {
        state.attemptVerdict = 'done';
        await expect(verify(JOB, '1234')).rejects.toThrow(/already used/i);
    });

    it('wrong PIN: throws incorrect message', async () => {
        state.attemptVerdict = 'wrong';
        await expect(verify(JOB, '9999')).rejects.toThrow(/incorrect/i);
    });
});

describe('completion PIN: frozen policy, market isolation, fail-closed (area 3, 2026-11-13)', () => {
    beforeEach(() => { state.secret = { completion_pin: '1234' }; state.policy = null; state.attemptVerdict = 'ok'; state.overrideError = false; });
    const stamped = (effective: string, driver = 'd1') => ({ ...JOB, metadata: { completion_pin_required: effective !== 'disabled',
        completion_pin_effective: effective, completion_pin_driver_id: driver } });

    it('the policy frozen at assignment wins over a later override change', async () => {
        state.policy = 'required';
        expect(await verify(stamped('disabled'), undefined)).toBeTruthy();
    });
    it('a stamp for another driver is ignored (reassigned job): the current override applies', async () => {
        state.policy = 'required';
        await expect(verify(stamped('disabled', 'someone-else'), undefined)).rejects.toThrow(/required/i);
    });
    it('no override: the booking market policy applies (optional)', async () => {
        const job = { ...JOB, metadata: { completion_pin_market_policy: 'optional', completion_pin_required: true } };
        expect(await verify(job, undefined)).toBeTruthy();
    });
    it('no override, market disabled: no PIN', async () => {
        const job = { ...JOB, metadata: { completion_pin_market_policy: 'disabled', completion_pin_required: false } };
        expect(await verify(job, undefined)).toBeTruthy();
    });
    it('override read fails: required (never relaxed), even when the market disables the PIN', async () => {
        state.overrideError = true;
        const job = { ...JOB, metadata: { completion_pin_market_policy: 'disabled', completion_pin_required: false } };
        await expect(verify(job, undefined)).rejects.toThrow(/required/i);
    });
});
