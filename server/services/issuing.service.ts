import { ShoppingBudgetService } from './shopping-budget.service';
import { FareSplitService } from './fare-split.service';
import { approvedErrandBudget } from '../../src/app/shared/utils/errand-budget';
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

type StoredIssuingRecord = Record<string, any>;

const isIssuingEnabled = () => process.env.STRIPE_ISSUING_ENABLED === 'true';

const moneyToMinor = (amount: number,currency='GBP'): number => FareSplitService.toMinor(amount,currency);

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

const sanitizePersonName = (value: string): string => {
  return value
    .replace(/[^a-zA-Z\s.,'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const getNameParts = (profile: Record<string, any>): { firstName: string; lastName: string } => {
  const first = sanitizePersonName(String(profile['first_name'] || profile['firstName'] || '').trim());
  const last = sanitizePersonName(String(profile['last_name'] || profile['lastName'] || '').trim());

  if (first && last) {
    return { firstName: first, lastName: last };
  }

  const full = sanitizePersonName(String(profile['full_name'] || profile['name'] || getName(profile)).trim());
  const parts = full.split(' ').filter(Boolean);

  if (parts.length >= 2) {
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' ')
    };
  }

  return {
    firstName: first || parts[0] || 'Movabi',
    lastName: last || 'Driver'
  };
};

const normalizePhone = (profile: Record<string, any>): string | null => {
  const raw = String(
    profile['phone'] ||
    profile['phone_number'] ||
    profile['mobile'] ||
    profile['contact_phone'] ||
    ''
  ).trim();

  if (!raw) {
    return null;
  }

  const cleaned = raw.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    return cleaned.length >= 8 ? cleaned : null;
  }

  const country = String(profile['country_code'] || profile['country'] || 'GB').toUpperCase();

  if ((country === 'GB' || country === 'UK') && cleaned.startsWith('0')) {
    return `+44${cleaned.slice(1)}`;
  }

  if (country === 'NG' && cleaned.startsWith('0')) {
    return `+234${cleaned.slice(1)}`;
  }

  return cleaned.length >= 10 ? `+${cleaned}` : null;
};

const defaultBilling = () => ({
  address: {
    line1: process.env.STRIPE_ISSUING_BILLING_LINE1 || 'Movabi Driver Card',
    city: process.env.STRIPE_ISSUING_BILLING_CITY || 'London',
    country: process.env.STRIPE_ISSUING_BILLING_COUNTRY || 'GB',
    postal_code: process.env.STRIPE_ISSUING_BILLING_POSTAL_CODE || 'SW1A 1AA'
  }
});

export class IssuingService {
  static async ensureDriverVirtualCard(driverId: string, tenantId?: string | null): Promise<IssuingStatus> {
    if (!isIssuingEnabled()) {
      return {
        enabled: false,
        status: 'not_configured',
        message: 'Movabi Pay virtual cards are not enabled yet.',
        jobId: '',
        driverId,
        currency: 'GBP'
      };
    }

    const card = await this.ensureDriverCard(driverId, tenantId || undefined);

    return {
      enabled: true,
      status: 'ready',
      message: 'Movabi Pay virtual card is ready for errand purchases.',
      jobId: '',
      driverId,
      cardId: card.stripe_card_id,
      cardholderId: card.stripe_cardholder_id,
      currency: card.currency_code || 'GBP',
      last4: card.last4 || null,
      cardStatus: card.status || null
    };
  }

  static async createCardDetailsEphemeralKey(
    driverId: string,
    cardId: string,
    nonce: string
  ): Promise<{ ephemeralKeySecret: string }> {
    if (!isIssuingEnabled()) {
      throw new Error('Movabi Pay virtual cards are not enabled yet.');
    }

    if (!cardId || !nonce) {
      throw new Error('cardId and nonce are required.');
    }

    const { data: card, error } = await supabaseAdmin
      .from('driver_issuing_cards')
      .select('stripe_card_id')
      .eq('driver_id', driverId)
      .eq('stripe_card_id', cardId)
      .eq('card_type', 'virtual')
      .maybeSingle();

    if (error || !card) {
      throw new Error('Movabi Pay virtual card not found for this driver.');
    }

    const ephemeralKey = await (stripe.ephemeralKeys as any).create(
      {
        nonce,
        issuing_card: cardId
      },
      {
        apiVersion: '2023-10-16'
      }
    );

    return {
      ephemeralKeySecret: ephemeralKey.secret
    };
  }

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
        message: 'Driver needs a Movabi Pay virtual card before shop purchases.',
        jobId,
        driverId: job.driver_id,
        budgetLimit,
        currency: job.currency_code || 'GBP'
      };
    }

    const controlMetadata = this.parseMetadata(existing?.['metadata']);
    const needsLimitSync = existing?.['status'] === 'active'
      && budgetLimit > 0
      && (
        Math.abs(parseMoney(existing?.['amount_limit']) - budgetLimit) >= 0.01
        || controlMetadata['spending_limit_interval'] !== 'per_authorization'
      );

    if (needsLimitSync) {
      try {
        if(process.env.STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED !== 'true') throw new Error('Shopping card authorization safety settings require verification');
        await ShoppingBudgetService.assertCustomerFunds(jobId,budgetLimit);
        await ShoppingBudgetService.reserve(jobId,budgetLimit,String(job.currency_code || 'GBP'));
        await stripe.issuing.cards.update(card.stripe_card_id, {
          spending_controls: {
            spending_limits: [{ amount: moneyToMinor(budgetLimit,String(job.currency_code || 'GBP')), interval: 'per_authorization' }]
          }
        } as any);
        await supabaseAdmin
          .from('job_issuing_spend_controls')
          .update({
            amount_limit: budgetLimit,
            metadata: {
              ...controlMetadata,
              spending_limit_minor: moneyToMinor(budgetLimit,String(job.currency_code || 'GBP')),
              spending_limit_interval: 'per_authorization'
            },
            updated_at: new Date().toISOString()
          })
          .eq('job_id', jobId);
      } catch (error) {
        console.warn('[IssuingService] Could not synchronize active errand card limit', error);
      }
    }

    return {
      enabled: true,
      status: existing?.status === 'active' ? 'active' : 'ready',
      message: existing?.status === 'active'
        ? 'Movabi Pay virtual card is active for this errand budget.'
        : 'Movabi Pay virtual card is ready. Activate it before the driver shops.',
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

    const isErrand = await this.isErrandJob(job);

    if (!isErrand) {
      throw new Error('Movabi Pay card is only used for errand item budgets.');
    }

    if (!job.driver_id) {
      throw new Error('A driver must be assigned before activating a Movabi Pay card.');
    }

    const budget = await this.getReservedBudget(jobId);

    if (budget <= 0) {
      throw new Error('No item budget is reserved for this errand.');
    }

    if(process.env.STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED !== 'true') throw new Error('Shopping card authorization safety settings require verification');
    await ShoppingBudgetService.assertCustomerFunds(jobId,budget);
    await ShoppingBudgetService.reserve(jobId,budget,String(job.currency_code || 'GBP'));
    const card = await this.ensureDriverCard(job.driver_id, job.tenant_id);
    await this.assertCardholderCanUseCard(card.stripe_cardholder_id);

    const currency = String(job.currency_code || 'GBP').toLowerCase();
    const limitAmount = moneyToMinor(budget,String(job.currency_code || 'GBP'));

    const {error: controlError}=await supabaseAdmin.rpc('activate_job_issuing_control',{
      p_job:jobId,p_card:card.stripe_card_id,p_budget:budget,
      p_metadata:{spending_limit_minor:limitAmount,spending_limit_interval:'per_authorization',card_presence:'in_person_only'}
    });
    if(controlError) throw new Error(controlError.message);
    await stripe.issuing.cards.update(card.stripe_card_id,{status:'inactive'});
    await stripe.issuing.cards.update(card.stripe_card_id,{
      status:'active',spending_controls:{spending_limits:[{amount:limitAmount,interval:'per_authorization'}]},
      metadata:{active_job_id:jobId,driver_id:job.driver_id,tenant_id:job.tenant_id || ''}
    });

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
    const cardId = typeof authorization.card === 'string' ? authorization.card : authorization.card?.id;
    const pending = authorization.pending_request;
    if (!cardId || !pending || pending.currency !== authorization.currency) return { approved:false };
    const {data:control,error:controlError}=await supabaseAdmin.from('job_issuing_spend_controls')
      .select('job_id,amount_limit').eq('stripe_card_id',cardId).eq('status','active').maybeSingle();
    if(controlError || !control) return {approved:false};
    await ShoppingBudgetService.assertCustomerFunds(control.job_id,Number(control.amount_limit));

    const { data,error } = await supabaseAdmin.rpc('record_issuing_authorization_request',{
      p_card:cardId,p_authorization:authorization.id,p_amount:FareSplitService.fromMinor(pending.amount,pending.currency),
      p_currency:pending.currency,p_event:authorization
    });
    if(error) throw new Error(error.message);
    return data;
  }

  static async syncAuthorization(authorization: Stripe.Issuing.Authorization): Promise<void> {
    const {error}=await supabaseAdmin.from('job_issuing_authorizations').update({
      status:authorization.status,raw_event:authorization,updated_at:new Date().toISOString()
    }).eq('stripe_authorization_id',authorization.id);
    if(error) throw new Error(error.message);
  }

  static async syncTransaction(transaction: Stripe.Issuing.Transaction): Promise<void> {
    const cardId = typeof transaction.card === 'string' ? transaction.card : transaction.card?.id;
    const authId = typeof transaction.authorization === 'string' ? transaction.authorization : transaction.authorization?.id;
    if(!cardId || !authId) throw new Error('Issuing transaction attribution requires reconciliation');
    const {error}=await supabaseAdmin.rpc('record_issuing_transaction',{
      p_id:transaction.id,p_authorization:authId,p_card:cardId,
      p_amount:FareSplitService.fromMinor(Math.abs(transaction.amount),transaction.currency),
      p_currency:transaction.currency,p_type:transaction.type,p_event:transaction
    });
    if(error) throw new Error(error.message);
  }

  private static async getJob(jobId: string): Promise<Record<string, any> | null> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(slug, name)')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data as Record<string, any> | null;
  }

  private static async isErrandJob(job: Record<string, any>): Promise<boolean> {
    const metadata = this.parseMetadata(job['metadata']);
    const serviceType = this.parseMetadata(job['service_type']);
    const candidates = [
      job['service_slug'],
      job['service_type'],
      serviceType['slug'],
      serviceType['name'],
      metadata['service_slug'],
      metadata['service_type']
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);

    if (candidates.some((value) => value === 'errand' || value.includes('errand'))) {
      return true;
    }

    if (metadata['errand_details']) {
      return true;
    }

    const { data } = await supabaseAdmin
      .from('errand_details')
      .select('id')
      .eq('job_id', job['id'])
      .limit(1)
      .maybeSingle();

    return !!data;
  }

  private static async getReservedBudget(jobId: string): Promise<number> {
    const [{ data: funding }, { data: details }, { data: job }] = await Promise.all([
      supabaseAdmin
        .from('errand_funding')
        .select('item_budget, amount_reserved, over_budget_status, over_budget_amount, requested_over_budget_amount, metadata')
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

    const initialItemBudget = this.firstPositiveMoney(
      (details as any)?.estimated_budget,
      errandMetadata['budget'],
      errandMetadata['estimated_budget'],
      errandMetadata['wallet_budget'],
      paymentSplit['item_budget']
    );
    const fundingRecord = (funding || {}) as Record<string, any>;
    return approvedErrandBudget(fundingRecord, initialItemBudget);
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
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .maybeSingle();

    if (error || !profile) {
      throw new Error('Driver profile was not found for Issuing card setup.');
    }

    const existing = await this.getDriverCard(driverId);

    if (existing) {
      const cardholderRecord = await this.ensureCardholder(driverId, tenantId, profile as Record<string, any>);
      await this.assertCardholderCanUseCard(cardholderRecord.stripe_cardholder_id);

      if (existing.stripe_cardholder_id !== cardholderRecord.stripe_cardholder_id) {
        await supabaseAdmin
          .from('driver_issuing_cards')
          .update({
            stripe_cardholder_id: cardholderRecord.stripe_cardholder_id,
            updated_at: new Date().toISOString()
          })
          .eq('id', existing['id']);

        return {
          ...existing,
          stripe_cardholder_id: cardholderRecord.stripe_cardholder_id
        };
      }

      return existing;
    }

    const cardholderRecord = await this.ensureCardholder(driverId, tenantId, profile as Record<string, any>);
    await this.assertCardholderCanUseCard(cardholderRecord.stripe_cardholder_id);

    const cardParams: Record<string, any> = {
      cardholder: cardholderRecord.stripe_cardholder_id,
      currency: 'gbp',
      type: 'virtual',
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

    const card = await stripe.issuing.cards.create(cardParams as any);

    const payload = {
      driver_id: driverId,
      tenant_id: tenantId || null,
      stripe_cardholder_id: cardholderRecord.stripe_cardholder_id,
      stripe_card_id: card.id,
      card_type: card.type || 'virtual',
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
    const phoneNumber = normalizePhone(profile);

    if (!phoneNumber) {
      throw new Error('Driver phone number is required before creating a Movabi Pay virtual card.');
    }

    if (existing?.stripe_cardholder_id) {
      const cardholder = await this.refreshCardholderRecord(existing as StoredIssuingRecord, phoneNumber, profile);

      return {
        ...(existing as StoredIssuingRecord),
        status: cardholder.status || existing['status'] || 'active',
        metadata: cardholder as any
      };
    }

    const nameParts = getNameParts(profile);
    const cardholder = await stripe.issuing.cardholders.create({
      name: getName(profile),
      email: getEmail(profile, driverId),
      phone_number: phoneNumber,
      type: 'individual',
      individual: {
        first_name: nameParts.firstName,
        last_name: nameParts.lastName
      },
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

  private static async assertCardholderCanUseCard(cardholderId?: string | null): Promise<void> {
    if (!cardholderId) {
      throw new Error('Driver Movabi Pay cardholder is missing. Complete driver card setup first.');
    }

    const cardholder = await stripe.issuing.cardholders.retrieve(cardholderId);
    const blocker = this.cardholderRequirementMessage(cardholder as any);

    if (blocker) {
      await supabaseAdmin
        .from('driver_issuing_cardholders')
        .update({
          status: cardholder.status || 'requirements_due',
          metadata: cardholder as any,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_cardholder_id', cardholderId);

      throw new Error(blocker);
    }
  }

  private static async refreshCardholderRecord(
    existing: StoredIssuingRecord,
    phoneNumber: string,
    profile: Record<string, any>
  ): Promise<Record<string, any>> {
    const cardholder = await stripe.issuing.cardholders.retrieve(existing.stripe_cardholder_id);
    const currentPhone = String((cardholder as any).phone_number || '').trim();
    const individual = this.parseMetadata((cardholder as any).individual);
    const nameParts = getNameParts(profile);
    const needsName = !String(individual['first_name'] || '').trim() || !String(individual['last_name'] || '').trim();
    const updateParams: Record<string, any> = {};

    if (!currentPhone) {
      updateParams.phone_number = phoneNumber;
    }

    if (needsName) {
      updateParams.individual = {
        first_name: nameParts.firstName,
        last_name: nameParts.lastName
      };
    }

    const nextCardholder = Object.keys(updateParams).length === 0
      ? cardholder
      : await stripe.issuing.cardholders.update(
        existing.stripe_cardholder_id,
        updateParams as any
      );

    await supabaseAdmin
      .from('driver_issuing_cardholders')
      .update({
        status: nextCardholder.status || existing['status'] || 'active',
        metadata: nextCardholder as any,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing['id']);

    return nextCardholder as any;
  }

  private static cardholderRequirementMessage(cardholder: Record<string, any>): string | null {
    const requirements = this.parseMetadata(cardholder['requirements']);
    const dueFields = [
      ...this.arrayStrings(requirements['currently_due']),
      ...this.arrayStrings(requirements['past_due'])
    ];
    const disabledReason = String(requirements['disabled_reason'] || '').trim();
    const uniqueDueFields = [...new Set(dueFields)].filter(Boolean);

    if (!disabledReason && uniqueDueFields.length === 0) {
      return null;
    }

    const readableFields = uniqueDueFields.length
      ? uniqueDueFields.map((field) => field.replace(/^individual\./, '').replace(/_/g, ' ')).join(', ')
      : 'Stripe Issuing verification';
    const reason = disabledReason ? ` Stripe reason: ${disabledReason}.` : '';

    return `Movabi Pay virtual card cannot be activated yet. Stripe needs: ${readableFields}.${reason} Complete the driver Issuing requirements in Stripe, then retry card setup.`;
  }

  private static arrayStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  }
}
