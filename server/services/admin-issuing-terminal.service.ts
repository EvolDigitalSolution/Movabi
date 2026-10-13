import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { FareSplitService } from './fare-split.service';
import { AuditService } from './audit.service';

export class AdminIssuingTerminalService {
    private static async testRequest(path: string, params: Record<string,string>, key: string): Promise<any> {
        // This project's Stripe SDK predates Issuing authorization test helpers.
        const response = await fetch('https://api.stripe.com/v1/test_helpers/issuing/'+path, {
            method:'POST', signal:AbortSignal.timeout(20000),
            headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded','Stripe-Version':'2023-10-16','Idempotency-Key':key},
            body:new URLSearchParams(params)
        });
        const data = await response.json() as any;
        if (!response.ok) throw new Error(String(data.error?.message || 'Stripe test checkout failed').replace(/sk_(test|live)_[^\s]+/g,'[redacted]'));
        return data;
    }
    static async mode() {
        const balance = await stripe.balance.retrieve();
        const test = (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') && balance.livemode === false;
        return { mode: test ? 'test' : 'live', simulationEnabled: test && process.env.STRIPE_ISSUING_ENABLED === 'true' && process.env.STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED === 'true' };
    }
    static async context() {
        const mode = await this.mode();
        if (!mode.simulationEnabled) return { ...mode, jobs: [] };
        const { data, error } = await supabaseAdmin.from('job_issuing_spend_controls')
            .select('job_id,currency_code,amount_limit,amount_captured').eq('status','active').limit(50);
        if (error) throw new Error('Test cards could not be loaded');
        return { ...mode, jobs: data || [] };
    }
    static async purchase(adminId: string, body: { jobId?: string; amount?: number; requestId?: string }) {
        const mode = await this.mode();
        if (!mode.simulationEnabled) throw new Error('Simulated purchases require test Stripe, enabled Issuing and confirmed fail-closed authorization. Live cards cannot use this test terminal.');
        if (!/^[0-9a-f-]{36}$/i.test(body.jobId || '') || !/^[0-9a-f-]{36}$/i.test(body.requestId || '')) throw new Error('Invalid test purchase reference');
        if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > 1000) throw new Error('Enter a test purchase amount between 0 and 1000');
        const { data: control, error } = await supabaseAdmin.from('job_issuing_spend_controls')
            .select('job_id,stripe_card_id,currency_code').eq('job_id',body.jobId).eq('status','active').single();
        if (error || !control) throw new Error('This job has no active shopping card');
        const card = await stripe.issuing.cards.retrieve(control.stripe_card_id);
        if (card.livemode !== false || card.status !== 'active') throw new Error('Expected an active test card');
        const currency = String(control.currency_code).toLowerCase();
        if (card.currency !== currency) throw new Error('Card and job currencies differ');
        const amount = FareSplitService.toMinor(body.amount,currency);
        if (!Number.isSafeInteger(amount) || amount <= 0 || FareSplitService.fromMinor(amount,currency) !== body.amount) throw new Error('Use the currency’s supported decimal precision');
        const key = `movabi-admin-pos-${adminId}-${body.requestId}`;
        const authorization = await this.testRequest('authorizations', {
            card:card.id, amount:String(amount), currency, authorization_method:'contactless',
            'merchant_data[name]':'Movabi TEST checkout','merchant_data[category]':'grocery_stores_supermarkets','merchant_data[country]':'GB'
        }, key+'-authorize');
        if (authorization.livemode) throw new Error('Unexpected live authorization');
        if (!authorization.approved) {
            await AuditService.log({userId:adminId,action:'admin_test_card_declined',entityType:'job',entityId:body.jobId,metadata:{authorizationId:authorization.id,amount,currency}});
            return { approved:false, captured:false, authorizationId:authorization.id, amount:body.amount, currency };
        }
        // The real authorization webhook must have accepted this job/card. Never force approval or capture.
        const { data: approval, error: approvalError } = await supabaseAdmin.from('job_issuing_authorizations')
            .select('job_id,approved,stripe_card_id').eq('stripe_authorization_id',authorization.id).maybeSingle();
        if (approvalError || !approval?.approved || approval.job_id !== body.jobId || approval.stripe_card_id !== card.id)
            throw new Error(`Test authorization ${authorization.id} was not verified by Movabi. No capture performed.`);
        await this.testRequest(`authorizations/${authorization.id}/capture`,
            { capture_amount:String(amount), close_authorization:'true' },key+'-capture');
        await AuditService.log({userId:adminId,action:'admin_test_card_purchase',entityType:'job',entityId:body.jobId,metadata:{authorizationId:authorization.id,amount,currency,requestId:body.requestId}});
        return { approved:true,captured:true,authorizationId:authorization.id,amount:body.amount,currency };
    }
}
