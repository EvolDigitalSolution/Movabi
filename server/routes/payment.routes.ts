import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { FraudService } from '../services/fraud.service';
import { CityService } from '../services/city.service';
import { EmailService } from '../services/email.service';

const router = Router();

router.post('/calculate-price', async (req: Request, res: Response) => {
    try {
        const {
            lat,
            lng,
            basePrice,
            distanceKm,
            serviceType,
            serviceSlug,
            countryCode,
            currencyCode,
            pricingPlan
        } = req.body;

        if (lat === undefined || lng === undefined) {
            return res.status(400).json({ error: 'lat and lng are required' });
        }

        if (basePrice === undefined && distanceKm === undefined) {
            return res.status(400).json({ error: 'Either basePrice or distanceKm must be provided' });
        }

        const city = await CityService.findCityForLocation(Number(lat), Number(lng));

        const pricing = await PricingService.resolvePrice({
            lat: Number(lat),
            lng: Number(lng),
            basePrice: basePrice !== undefined ? Number(basePrice) : undefined,
            distanceKm: distanceKm !== undefined ? Number(distanceKm) : undefined,
            serviceSlug: serviceSlug || serviceType || 'ride',
            countryCode: countryCode || (city as any)?.country_code || (city as any)?.country || 'GB',
            currencyCode,
            pricingPlan: pricingPlan || 'starter',
            city
        });

        const stats = await dispatchService.getAreaStats(Number(lat), Number(lng));
        let surge = PricingService.getSurgeMultiplier(stats.demand, stats.supply);

        if (city && Number(city.base_surge_multiplier || 1) > 1) {
            surge = Math.max(surge, Number(city.base_surge_multiplier));
        }

        const totalPrice = Number((pricing.basePrice * surge).toFixed(2));

        return res.json({
            basePrice: pricing.basePrice,
            surgeMultiplier: surge,
            totalPrice,
            demand: stats.demand,
            supply: stats.supply,
            city: city?.name || 'Unknown',
            pricingSource: pricing.source,

            countryCode: pricing.countryCode,
            currencyCode: pricing.currencyCode,
            currencySymbol: pricing.currencySymbol,
            pricingPlanUsed: pricing.pricingPlanUsed,
            regionalPricingRuleId: pricing.regionalPricingRuleId,
            taxAmount: pricing.taxAmount,
            platformFee: pricing.platformFee,
            driverPayout: pricing.driverPayout,
            commissionRateUsed: pricing.commissionRateUsed,
            baseFareUsed: pricing.baseFareUsed,
            pricePerKmUsed: pricing.pricePerKmUsed
        });
    } catch (error: any) {
        console.error('[PaymentRoutes] Error calculating price:', error);
        return res.status(500).json({ error: error.message || 'Failed to calculate price' });
    }
});

router.post('/create-intent', async (req: Request, res: Response) => {
    try {
        const { jobId, tenantId, surgeMultiplier } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ error: 'Stripe is not configured on the server' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select(`
        id,
        customer_id,
        tenant_id,
        status,
        payment_status,
        payment_method,
        payment_intent_id,
        price,
        total_price,
        currency_code,
        currency_symbol,
        country_code
      `)
            .eq('id', jobId)
            .maybeSingle();

        if (jobError) {
            console.error('Error fetching job:', jobError);
            return res.status(500).json({ error: 'Failed to fetch job' });
        }

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (['completed', 'cancelled', 'canceled'].includes(String(job.status || '').toLowerCase())) {
            return res.status(400).json({ error: `Cannot create payment intent for job status ${job.status}` });
        }

        if (job.payment_intent_id) {
            const existingIntent = await stripe.paymentIntents.retrieve(job.payment_intent_id);

            return res.json({
                clientSecret: existingIntent.client_secret,
                paymentIntentId: existingIntent.id,
                reused: true
            });
        }

        const amount = Number(job.price || job.total_price || req.body.amount || 0);
        const currency = String(job.currency_code || req.body.currency || 'GBP').toLowerCase();

        if (!amount || Number.isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Job amount must be a positive number' });
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, account_status')
            .eq('id', job.customer_id)
            .maybeSingle();

        if (profileError) {
            console.error('Error fetching profile:', profileError);
            return res.status(500).json({ error: 'Failed to fetch customer profile' });
        }

        if (profile?.account_status && profile.account_status !== 'active') {
            return res.status(403).json({
                error: `Account is ${profile.account_status}. Payment not allowed.`
            });
        }

        const fraudCheck = await FraudService.checkCancellationAbuse(job.customer_id);

        if (fraudCheck.isAbusing) {
            return res.status(403).json({ error: `Booking restricted: ${fraudCheck.reason}` });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency,
            payment_method_types: ['card'],
            capture_method: 'manual',
            metadata: {
                jobId: String(jobId),
                tenantId: String(tenantId || job.tenant_id || ''),
                purpose: 'job_payment',
                surgeMultiplier: String(surgeMultiplier || 1),
                countryCode: String(job.country_code || ''),
                currencySymbol: String(job.currency_symbol || '')
            }
        });

        const { error: updateError } = await supabaseAdmin
            .from('jobs')
            .update({
                payment_intent_id: paymentIntent.id,
                payment_status: 'authorized',
                payment_method: 'card',
                surge_multiplier: surgeMultiplier || 1
            })
            .eq('id', jobId);

        if (updateError) {
            console.error('Error updating job:', updateError);
            return res.status(500).json({ error: 'Failed to update job payment status' });
        }

        return res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            amount,
            currency: currency.toUpperCase()
        });
    } catch (error: any) {
        console.error('Error creating payment intent:', error);
        return res.status(500).json({ error: error.message || 'Failed to create payment intent' });
    }
});

router.post('/create-wallet-topup-intent', async (req: Request, res: Response) => {
    try {
        const { userId, amount, currency, tenantId } = req.body;

        if (!userId || amount === undefined || !currency) {
            return res.status(400).json({ error: 'userId, amount, and currency are required' });
        }

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'amount must be a positive number' });
        }

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ error: 'Stripe is not configured on the server' });
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            throw new Error('User not found');
        }

        if (profile.account_status && profile.account_status !== 'active') {
            return res.status(403).json({ error: `Account is ${profile.account_status}. Payment not allowed.` });
        }

        const fraudCheck = await FraudService.checkWalletAbuse(userId, Number(amount));

        if (fraudCheck.isSuspicious) {
            return res.status(403).json({ error: `Suspicious activity: ${fraudCheck.reason}` });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(Number(amount) * 100),
            currency: String(currency).toLowerCase(),
            payment_method_types: ['card'],
            metadata: {
                userId,
                tenantId: tenantId || '',
                type: 'wallet_topup'
            }
        });

        return res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (error: any) {
        console.error('Error creating wallet top-up intent:', error);
        return res.status(500).json({ error: error.message });
    }
});

router.post('/confirm-wallet-topup', async (req: Request, res: Response) => {
    try {
        const { paymentIntentId, userId, amount } = req.body;

        if (!paymentIntentId || !userId || !amount) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== 'succeeded') {
            return res.status(400).json({ error: 'Payment not complete' });
        }

        const { data: processed, error: rpcError } = await supabaseAdmin.rpc('finalize_wallet_topup', {
            p_user_id: userId,
            p_amount: Number(amount),
            p_payment_intent_id: paymentIntentId,
            p_description: 'Wallet top-up'
        });

        if (rpcError) throw rpcError;

        if (processed) {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('email')
                .eq('id', userId)
                .single();

            if (profile?.email) {
                await EmailService.sendReceipt(profile.email, {
                    amount: Number(amount),
                    currency: pi.currency.toUpperCase(),
                    transactionId: paymentIntentId,
                    description: 'Wallet Top-up',
                    date: new Date()
                });
            }
        }

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Error confirming wallet top-up:', error);
        return res.status(500).json({ error: error.message });
    }
});

router.post('/refund', async (req: Request, res: Response) => {
    try {
        const { paymentIntentId, amount, reason, jobId } = req.body;

        if (!paymentIntentId) {
            return res.status(400).json({ error: 'paymentIntentId is required' });
        }

        const refundParams: any = {
            payment_intent: paymentIntentId
        };

        if (amount) {
            refundParams.amount = Math.round(Number(amount) * 100);
        }

        if (reason) {
            refundParams.reason = reason;
        }

        const refund = await stripe.refunds.create(refundParams);

        if (jobId) {
            await supabaseAdmin
                .from('jobs')
                .update({
                    payment_status: 'refunded',
                    refund_id: refund.id
                })
                .eq('id', jobId);
        }

        return res.json({ success: true, refundId: refund.id });
    } catch (error: any) {
        console.error('Error processing refund:', error);
        return res.status(500).json({ error: error.message });
    }
});

export default router;
