import { supabaseAdmin } from './supabase.service';

/** P3. The DB owns due-time checks, market scope, atomic inbox persistence and deduplication.
 * Requires a separate migration, an enabled tenant/GB/GBP scope and an explicit develop-only flag.
 * The f949a14 replacement bundle does not include this worker or its migration. */
export class DebtFollowupService {
    private running = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(private readonly deps: {
        env?: Record<string, string | undefined>;
        db?: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<any> };
        log?: (message: string) => void;
    } = {}) {}
    private get enabled() {
        const env = this.deps.env ?? process.env;
        return env.VAYDU_DEPLOYMENT_ENV === 'develop' && env.VAYDU_DEBT_FOLLOWUPS === 'true';
    }
    async runOnce(): Promise<{ skipped?: string; reminders?: number; reviews?: number }> {
        if (!this.enabled) return { skipped: 'disabled' };
        if (this.running) return { skipped: 'running' };
        this.running = true;
        try {
            const { data, error } = await (this.deps.db ?? supabaseAdmin).rpc('process_overdue_customer_debts', { p_limit: 100 });
            if (error) throw new Error('Debt followup transaction failed');
            if (!Number.isInteger(data?.reminders) || data.reminders < 0 || !Number.isInteger(data?.reviews) || data.reviews < 0)
                throw new Error('Debt followup result invalid');
            return { reminders: data.reminders, reviews: data.reviews };
        } finally { this.running = false; }
    }
    start(): boolean {
        if (!this.enabled || this.timer) return false;
        const tick = () => { void this.runOnce().catch(() =>
            (this.deps.log ?? console.warn)('[DebtFollowup] transaction unavailable; retrying next minute')); };
        this.timer = setInterval(tick, 60_000);
        this.timer.unref?.();
        tick();
        return true;
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
