import Stripe from 'stripe';
import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';

type IssuingCardStatus =
  | 'not_configured'
  | 'needs_driver_profile'
  | 'needs_cardholder'
  | 'ready'
  | 'active'
  | 'disabled'
  | 'error';

interface IssuingStatus {
  enabled: boolean;
  status: IssuingCardStatus;
  message: string;
  jobId: string;
  driverId?: string | null;
  cardId?: string | null;
  cardholderId?: string | null;
  budgetLimit?: number;
  currency?: string;
  last4?: string | null;
  cardStatus?: string | null;
}

const isIssuingEnabled = () => process.env.STRIPE_ISSUING_ENABLED === 'true';

const moneyToMinor = (amount: number): number => {
  return Math.max(0, Math.round(Number(amount || 0) * 100));
};

const parseMoney = (value: unknown): number => {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
};

const getEmail = (profile: Record<string, any>, fallbackId: string): string => {
  const email = String(profile['email'] || profile['contact_email'] || '').trim();
  return email || `driver-${fallbackId}@movabi.local`;
};

const getName = (profile: Record<string, any>): string => {
  const first = String(profile['first_name'] || profile['firstName'] || '').trim();
  const last = String(profile['last_name'] || profile['lastName'] || '').trim();
  const full = String(profile['full_name'] || profile['name'] || '').trim();
  return [first, last].filter(Boolean).join(' ') || full || 'Movabi Driver';
};

const defaultBilling = () => ({
  address: {
    line1: process.env.STRIPE_ISSUING_BILLING_LINE1 || 'Movabi Driver Card',
    city: process.env.STRIPE_ISSUING_BILLING_CITY || 'London',
    country: process.env.STRIPE_ISSUING_BILLING_COUNTRY || 'GB',
    postal_code: process.env.STRIPE_ISSUING_BILLING_POSTAL_CODE || 'SW1A 1AA'
  }
});

const getIssuingCardType = (): 'virtual' | 'physical' => {
  return process.env.STRIPE_ISSUING_CARD_TYPE === 'physical' ? 'physical' : 'virtual';
};

const getPhysicalShipping = (name: string) => {
  const line1 = process.env.STRIPE_ISSUING_SHIPPING_LINE1;

  if (!line1) {
    return undefined;
  }

  return {
    name,
    service: process.env.STRIPE_ISSUING_SHIPPING_SERVICE || 'standard',
    address: {
      line1,
      city: process.env.STRIPE_ISSUING_SHIPPING_CITY || process.env.STRIPE_ISSUING_BILLING_CITY || 'London',
      country: process.env.STRIPE_ISSUING_SHIPPING_COUNTRY || process.env.STRIPE_ISSUING_BILLING_COUNTRY || 'GB',
      postal_code: process.env.STRIPE_ISSUING_SHIPPING_POSTAL_CODE || process.env.STRIPE_ISSUING_BILLING_POSTAL_CODE || 'SW1A 1AA'
    }
  };
};

export class IssuingService {
  static async getErrandCardStatus(jobId: string): Promise<IssuingStatus> {
    const job = await this.getJob(jobId);

    if (!job) {
      throw new Error('Request not found');
    }

    const budgetLimit = await this.getReservedBudget(jobId);
    const existing = await this.getJobSpendControl(jobId);

    if (!isIssuingEnabled()) {
      return {
        enabled: false,
        status: 'not_configured',
        message: 'Receipt upload is active. Movabi Pay card can be enabled after Stripe Issuing is approved.',
        jobId,
        driverId: job.driver_id,
        budgetLimit,
        currency: job.currency_code || 'GBP'
      };
    }

    if (!job.driver_id) {
      return {
        enabled: true,
        status: 'needs_driver_profile',
        message: 'Assign a driver before preparing the Movabi Pay card.',
        jobId,
        budgetLimit,
        currency: job.currency_code || 'GBP'
      };
    }

    const card = await this.getDriverCard(job.driver_id);

    if (!card) {
      return {
        enabled: true,
        status: 'needs_cardholder',
        message: 'Driver needs a Movabi Pay card before shop purchases.',
        jobId,
        driverId: job.driver_id,
        budgetLimit,
        currency: job.currency_code || 'GBP'
      };
    }

    return {
      enabled: true,
      status: existing?.status === 'active' ? 'active' : 'ready',
      message: existing?.status === 'active'
        ? 'Movabi Pay card is active for this errand budget.'
        : 'Movabi Pay card is ready. Activate it before the driver shops.',
      jobId,
      driverId: job.driver_id,
      cardId: card.stripe_card_id,
      cardholderId: card.stripe_cardholder_id,
      budgetLimit,
      currency: job.currency_code || 'GBP',
      last4: card.last4 || null,
      cardStatus: card.status || null
    };
  }

  static async activateErrandCard(jobId: string): Promise<IssuingStatus> {
    if (!isIssuingEnabled()) {
      return this.getErrandCardStatus(jobId);
    }

    const job = await this.getJob(jobId);

    if (!job) {
      throw new Error('Request not found');
    }

    if (job.service_slug !== 'errand') {
      throw new Error('Movabi Pay card is only used for errand item budgets.');
    }

    if (!job.driver_id) {
      throw new Error('A driver must be assigned before activating a Movabi Pay card.');
    }

    const budget = await this.getReservedBudget(jobId);

    if (budget <= 0) {
      throw new Error('No item budget is reserved for this errand.');
    }

    const card = await this.ensureDriverCard(job.driver_id, job.tenant_id);
    const currency = String(job.currency_code || 'GBP').toLowerCase();
    const limitAmount = moneyToMinor(budget);

    await stripe.issuing.cards.update(card.stripe_card_id, {
      status: 'active',
      spending_controls: {
        spending_limits: [
          {
            amount: limitAmount,
            interval: 'per_authorization'
          }
        ],
        blocked_card_presences: ['online']
      },
      metadata: {
        active_job_id: jobId,
        driver_id: job.driver_id,
        tenant_id: job.tenant_id || ''
      }
    } as any);

    await supabaseAdmin
      .from('job_issuing_spend_controls')
      .upsert(
        {
          job_id: jobId,
          driver_id: job.driver_id,
          customer_id: job.customer_id,
          tenant_id: job.tenant_id,
          stripe_card_id: card.stripe_card_id,
          amount_limit: budget,
          amount_authorized: 0,
          amount_captured: 0,
          currency_code: String(job.currency_code || 'GBP').toUpperCase(),
          status: 'active',
          metadata: {
            spending_limit_minor: limitAmount,
            card_presence: 'in_person_only'
          },
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        { onConflict: 'job_id' }
      );

    return this.getErrandCardStatus(jobId);
  }

  static async freezeDriverCard(driverId: string, reason = 'No active errand'): Promise<void> {
    const card = await this.getDriverCard(driverId);

    if (!card?.stripe_card_id || !isIssuingEnabled()) {
      return;
    }

    await stripe.issuing.cards.update(card.stripe_card_id, {
      status: 'inactive',
      metadata: {
        inactive_reason: reason
      }
    } as any);
  }

  static async handleAuthorizationRequest(authorization: Stripe.Issuing.Authorization) {
    const pendingAmount = Number((authorization as any).pending_request?.amount || 0);
    const cardId = typeof authorization.card === 'string' ? authorization.card : authorization.card?.id;

    if (!cardId) {
      return { approved: false, metadata: { reason: 'missing_card' } };
    }

    const { data: control } = await supabaseAdmin
      .from('job_issuing_spend_controls')
      .select('*')
      .eq('stripe_card_id', cardId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!control) {
      return { approved: false, metadata: { reason: 'no_active_job_limit' } };
    }

    const limitMinor = moneyToMinor(control.amount_limit);
    const alreadyAuthorizedMinor = moneyToMinor(control.amount_authorized);
    const nextTotalMinor = alreadyAuthorizedMinor + pendingAmount;
    const approved = pendingAmount > 0 && nextTotalMinor <= limitMinor;

    await supabaseAdmin
      .from('job_issuing_authorizations')
      .upsert(
        {
          stripe_authorization_id: authorization.id,
          job_id: control.job_id,
          driver_id: control.driver_id,
          stripe_card_id: cardId,
          amount: pendingAmount / 100,
          currency_code: String((authorization as any).pending_request?.currency || authorization.currency || control.currency_code || 'GBP').toUpperCase(),
          approved,
          merchant_name: authorization.merchant_data?.name || null,
          merchant_category: authorization.merchant_data?.category || null,
          status: authorization.status,
          raw_event: authorization as any,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'stripe_authorization_id' }
      );

    if (approved) {
      await supabaseAdmin
        .from('job_issuing_spend_controls')
        .update({
          amount_authorized: nextTotalMinor / 100,
          updated_at: new Date().toISOString()
        })
        .eq('id', control.id);
    }

    return {
      approved,
      metadata: {
        job_id: control.job_id,
        decision: approved ? 'within_job_budget' : 'over_job_budget'
      }
    };
  }

  static async syncAuthorization(authorization: Stripe.Issuing.Authorization): Promise<void> {
    const cardId = typeof authorization.card === 'string' ? authorization.card : authorization.card?.id;

    await supabaseAdmin
      .from('job_issuing_authorizations')
      .upsert(
        {
          stripe_authorization_id: authorization.id,
          stripe_card_id: cardId,
          amount: parseMoney(authorization.amount) / 100,
          currency_code: String(authorization.currency || 'GBP').toUpperCase(),
          approved: authorization.approved,
          merchant_name: authorization.merchant_data?.name || null,
          merchant_category: authorization.merchant_data?.category || null,
          status: authorization.status,
          raw_event: authorization as any,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'stripe_authorization_id' }
      );
  }

  static async syncTransaction(transaction: Stripe.Issuing.Transaction): Promise<void> {
    const cardId = typeof transaction.card === 'string' ? transaction.card : transaction.card?.id;
    const authId = typeof transaction.authorization === 'string'
      ? transaction.authorization
      : transaction.authorization?.id;

    const { data: control } = cardId
      ? await supabaseAdmin
        .from('job_issuing_spend_controls')
        .select('*')
        .eq('stripe_card_id', cardId)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      : { data: null };

    await supabaseAdmin
      .from('job_issuing_transactions')
      .upsert(
        {
          stripe_transaction_id: transaction.id,
          stripe_authorization_id: authId || null,
          job_id: control?.job_id || null,
          driver_id: control?.driver_id || null,
          stripe_card_id: cardId || null,
          amount: Math.abs(Number(transaction.amount || 0)) / 100,
          currency_code: String(transaction.currency || control?.currency_code || 'GBP').toUpperCase(),
          merchant_name: (transaction as any).merchant_data?.name || null,
          status: transaction.type,
          raw_event: transaction as any,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'stripe_transaction_id' }
      );

    if (control) {
      const amount = Math.abs(Number(transaction.amount || 0)) / 100;

      await supabaseAdmin
        .from('job_issuing_spend_controls')
        .update({
          amount_captured: parseMoney(control.amount_captured) + amount,
          updated_at: new Date().toISOString()
        })
        .eq('id', control.id);
    }
  }

  private static async getJob(jobId: string): Promise<Record<string, any> | null> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data as Record<string, any> | null;
  }

  private static async getReservedBudget(jobId: string): Promise<number> {
    const [{ data: funding }, { data: details }, { data: job }] = await Promise.all([
      supabaseAdmin
        .from('errand_funding')
        .select('amount_reserved')
        .eq('job_id', jobId)
        .maybeSingle(),
      supabaseAdmin
        .from('errand_details')
        .select('estimated_budget')
        .eq('job_id', jobId)
        .maybeSingle(),
      supabaseAdmin
        .from('jobs')
        .select('metadata')
        .eq('id', jobId)
        .maybeSingle()
    ]);

    const metadata = this.parseMetadata((job as any)?.metadata);
    const errandMetadata = this.parseMetadata(metadata['errand_details']);
    const paymentSplit = this.parseMetadata(metadata['payment_split']);

    return this.firstPositiveMoney(
      (funding as any)?.amount_reserved,
      (details as any)?.estimated_budget,
      errandMetadata['budget'],
      errandMetadata['estimated_budget'],
      errandMetadata['wallet_budget'],
      paymentSplit['item_budget']
    );
  }

  private static firstPositiveMoney(...values: unknown[]): number {
    for (const value of values) {
      const amount = parseMoney(value);

      if (amount > 0) {
        return amount;
      }
    }

    return 0;
  }

  private static parseMetadata(value: unknown): Record<string, any> {
    if (!value) {
      return {};
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
      } catch {
        return {};
      }
    }

    return typeof value === 'object' ? value as Record<string, any> : {};
  }

  private static async getJobSpendControl(jobId: string): Promise<Record<string, any> | null> {
    const { data } = await supabaseAdmin
      .from('job_issuing_spend_controls')
      .select('*')
      .eq('job_id', jobId)
      .maybeSingle();

    return data as Record<string, any> | null;
  }

  private static async getDriverCard(driverId: string): Promise<Record<string, any> | null> {
    const { data } = await supabaseAdmin
      .from('driver_issuing_cards')
      .select('*')
      .eq('driver_id', driverId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return data as Record<string, any> | null;
  }

  private static async ensureDriverCard(driverId: string, tenantId?: string): Promise<Record<string, any>> {
    const existing = await this.getDriverCard(driverId);

    if (existing) {
      return existing;
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .maybeSingle();

    if (error || !profile) {
      throw new Error('Driver profile was not found for Issuing card setup.');
    }

    const cardholderRecord = await this.ensureCardholder(driverId, tenantId, profile as Record<string, any>);

    const driverName = getName(profile as Record<string, any>);
    const cardType = getIssuingCardType();
    const cardParams: Record<string, any> = {
      cardholder: cardholderRecord.stripe_cardholder_id,
      currency: 'gbp',
      type: cardType,
      status: 'inactive',
      spending_controls: {
        spending_limits: [
          {
            amount: 1,
            interval: 'per_authorization'
          }
        ]
      },
      metadata: {
        driver_id: driverId,
        tenant_id: tenantId || '',
        purpose: 'movabi_errand_budget'
      }
    };

    if (cardType === 'physical') {
      const shipping = getPhysicalShipping(driverName);
      if (shipping) {
        cardParams['shipping'] = shipping;
      }
    }

    const card = await stripe.issuing.cards.create(cardParams as any);

    const payload = {
      driver_id: driverId,
      tenant_id: tenantId || null,
      stripe_cardholder_id: cardholderRecord.stripe_cardholder_id,
      stripe_card_id: card.id,
      card_type: card.type || 'physical',
      currency_code: String(card.currency || 'gbp').toUpperCase(),
      last4: (card as any).last4 || null,
      status: 'active',
      metadata: card as any,
      updated_at: new Date().toISOString()
    };

    const { data, error: insertError } = await supabaseAdmin
      .from('driver_issuing_cards')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) {
      throw insertError;
    }

    return data as Record<string, any>;
  }

  private static async ensureCardholder(
    driverId: string,
    tenantId: string | undefined,
    profile: Record<string, any>
  ): Promise<Record<string, any>> {
    const { data: existing } = await supabaseAdmin
      .from('driver_issuing_cardholders')
      .select('*')
      .eq('driver_id', driverId)
      .maybeSingle();

    if (existing?.stripe_cardholder_id) {
      return existing as Record<string, any>;
    }

    const cardholder = await stripe.issuing.cardholders.create({
      name: getName(profile),
      email: getEmail(profile, driverId),
      type: 'individual',
      status: 'active',
      billing: defaultBilling(),
      metadata: {
        driver_id: driverId,
        tenant_id: tenantId || ''
      }
    } as any);

    const { data, error } = await supabaseAdmin
      .from('driver_issuing_cardholders')
      .insert({
        driver_id: driverId,
        tenant_id: tenantId || null,
        stripe_cardholder_id: cardholder.id,
        status: cardholder.status || 'active',
        metadata: cardholder as any,
        updated_at: new Date().toISOString()
      })
      .select('*')
      .single();

    if (error) {
      throw error;
    }

    return data as Record<string, any>;
  }
}
