import { supabaseAdmin } from './supabase.service';
export class IssuingSpendService {
    static async sync(jobId: string, finalize = false): Promise<{ automated: boolean; pending?: boolean; spent?: number }> {
        const { data, error } = await supabaseAdmin.rpc('sync_job_issuing_spend', { p_job: jobId, p_finalize: finalize });
        if (error || !data) throw new Error('Shopping card spending could not be reconciled. Please try again shortly.');
        if (data.automated && (!Number.isFinite(Number(data.spent)) || Number(data.spent) < 0)) throw new Error('Invalid shopping card spending');
        return { ...data, spent: data.automated ? Number(data.spent) : undefined };
    }
}
