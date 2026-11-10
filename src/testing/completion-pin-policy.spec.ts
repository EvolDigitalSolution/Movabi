import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    secret: null as any,
    policy: 'required' as string | null,
    attemptVerdict: 'ok' as string,
};

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.secret, error: null }) }) }) }),
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
    beforeEach(() => { state.secret = { completion_pin: '1234' }; state.policy = 'required'; state.attemptVerdict = 'ok'; });

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
