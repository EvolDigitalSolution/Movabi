import type Stripe from 'stripe';
import { PaymentLayerError } from './payment-contracts';
export const CARD_SETUP_CONSENT_VERSION='save-card-on-session-setup-v1';
export const CARD_CONSENT_VERSION='save-card-on-session-v1';
export const STRIPE_MERCHANT='stripe-platform';
/** Only provider customer/method identifiers are stored; no PAN or CVC enters this store. */
export class StripeSavedCards {
  constructor(private readonly stripe:Stripe,private readonly db:any) {}
  private async customer(userId:string,create=false):Promise<string|null> {
    const query=await this.db.from('payment_customers').select('customer_reference')
      .eq('user_id',userId).eq('provider','stripe').eq('merchant_account_ref',STRIPE_MERCHANT).maybeSingle();
    if(query.error)throw new PaymentLayerError('SAVED_CARDS_UNAVAILABLE','Saved payment methods are unavailable');
    if(query.data?.customer_reference)return query.data.customer_reference;
    if(!create)return null;
    const customer=await this.stripe.customers.create({metadata:{vaydu_user_id:userId}},
      {idempotencyKey:`vaydu-customer-${STRIPE_MERCHANT}-${userId}`});
    const stored=await this.db.from('payment_customers').upsert({user_id:userId,provider:'stripe',
      merchant_account_ref:STRIPE_MERCHANT,customer_reference:customer.id},{onConflict:'user_id,provider,merchant_account_ref'});
    if(stored.error)throw new PaymentLayerError('SAVED_CARDS_UNAVAILABLE','Could not save payment customer');
    return customer.id;
  }
  /** No charge is created. Consent is retained in provider setup metadata. */
  async beginSetup(userId:string,requestId:string,consentVersion:string) {
    if(consentVersion!==CARD_SETUP_CONSENT_VERSION ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))
      throw new PaymentLayerError('INVALID_CARD_SETUP','Card-saving permission is required');
    const customer=(await this.customer(userId,true))!;
    const setup=await this.stripe.setupIntents.create({customer,payment_method_types:['card'],usage:'on_session',
      metadata:{vaydu_user_id:userId,consent_version:CARD_SETUP_CONSENT_VERSION,request_id:requestId.toLowerCase()}},
      {idempotencyKey:`vaydu-card-setup-${STRIPE_MERCHANT}-${userId}-${requestId.toLowerCase()}`});
    if(!setup.client_secret || setup.customer!==customer || setup.usage!=='on_session')
      throw new PaymentLayerError('CARD_SETUP_UNCONFIRMED','Card setup needs reconciliation');
    return {clientSecret:setup.client_secret,setupIntentId:setup.id};
  }
  async list(userId:string) {
    const customer=await this.customer(userId);if(!customer)return [];
    const result=await this.stripe.paymentMethods.list({customer,type:'card',limit:100});
    return result.data.filter(p=>p.card).map(p=>({id:p.id,brand:p.card!.brand,last4:p.card!.last4,
      expMonth:p.card!.exp_month,expYear:p.card!.exp_year}));
  }
  private async owned(userId:string,methodId:string) {
    if(!/^pm_[A-Za-z0-9]+$/.test(methodId))throw new PaymentLayerError('SAVED_CARD_NOT_FOUND','Saved card not found');
    const customer=await this.customer(userId);
    if(!customer)throw new PaymentLayerError('SAVED_CARD_NOT_FOUND','Saved card not found');
    const method=await this.stripe.paymentMethods.retrieve(methodId);
    const owner=typeof method.customer==='string'?method.customer:method.customer?.id;
    if(method.type!=='card'||owner!==customer)throw new PaymentLayerError('SAVED_CARD_NOT_FOUND','Saved card not found');
    return customer;
  }
  async remove(userId:string,methodId:string) {
    await this.owned(userId,methodId);await this.stripe.paymentMethods.detach(methodId);
  }
  async prepare(userId:string,jobId:string,save:boolean,methodId?:string):Promise<{customer?:string;setup_future_usage?:'on_session'}> {
    if(methodId)return {customer:await this.owned(userId,methodId)};
    if(!save)return {};
    const customer=(await this.customer(userId,true))!;
    const consent=await this.db.from('payment_card_consents').upsert({user_id:userId,job_id:jobId,
      provider:'stripe',merchant_account_ref:STRIPE_MERCHANT,version:CARD_CONSENT_VERSION,
      accepted_at:new Date().toISOString()},{onConflict:'job_id'});
    if(consent.error)throw new PaymentLayerError('SAVED_CARDS_UNAVAILABLE','Could not record card-saving permission');
    return {customer,setup_future_usage:'on_session'};
  }
}
