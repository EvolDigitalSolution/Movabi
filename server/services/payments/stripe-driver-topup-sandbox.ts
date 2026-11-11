import type Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {PaymentLayerError} from './payment-contracts';
import {stripeApiAmountFromLedger} from './stripe-currency-amounts';
import type {DriverCardAttemptStore,DriverCardExpected,DriverCardInput,DriverCardTopupAdapter} from './driver-card-topup-contracts';

const stop=():never=>{throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED','Verify the original sandbox payment');};
/** Maps a verified-identity, non-succeeded PaymentIntent to an explicit no-credit state. */
export function notSucceeded(pi:Pick<Stripe.PaymentIntent,'status'|'last_payment_error'>):never{
 switch(pi.status){
  case 'requires_action':
   // Customer authentication (3D Secure) is outstanding on THIS PaymentIntent. Not
   // "processing": nothing will progress until the customer completes it, which
   // they can do after a reload via /resume (same PaymentIntent, never a new one).
   throw new PaymentLayerError('PAYMENT_ACTION_REQUIRED','Customer authentication is required to complete this payment');
  case 'processing':case 'requires_confirmation':
   throw new PaymentLayerError('PAYMENT_PENDING','Payment is not final yet');
  case 'requires_payment_method':
   if(pi.last_payment_error)throw new PaymentLayerError('PAYMENT_FAILED','The card payment failed');
   throw new PaymentLayerError('PAYMENT_NOT_COMPLETED','Payment has not been completed');
  case 'canceled':
   throw new PaymentLayerError('PAYMENT_CANCELLED','Payment was cancelled');
  default:
   return stop();
 }
}
/** Separate driver funding adapter. Existing checkout, saved cards and payouts are untouched. */
export class StripeDriverTopupSandbox implements DriverCardTopupAdapter {
 readonly provider='stripe';
 private readonly fingerprint:string;
 constructor(private readonly stripe:Stripe,secret:string,private readonly merchant:string,private readonly store:DriverCardAttemptStore){
  if(!/^sk_test_[A-Za-z0-9_]+$/.test(secret))throw new PaymentLayerError('STRIPE_SANDBOX_REQUIRED','Stripe test credentials required');
  this.fingerprint=createHash('sha256').update(secret).digest('hex');
 }
 private async account(input:DriverCardExpected){
  if(input.merchantAccountRef!==this.merchant||!input.providerAccountId?.startsWith('acct_'))return stop();
  const account=await this.stripe.accounts.retrieve();
  if(account.id!==input.providerAccountId)return stop();
  return account.id;
 }
 async preflight(input:DriverCardInput){
  await this.account(input);
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  if(total<=0||total>99999999||stripeApiAmountFromLedger(input.walletAmountMinor,input.currency,input.exponent)+stripeApiAmountFromLedger(input.feeMinor,input.currency,input.exponent)!==total)return stop();
 }
 async createCheckout(input:DriverCardInput){
  const account=await this.account(input);
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  const wallet=stripeApiAmountFromLedger(input.walletAmountMinor,input.currency,input.exponent);
  const fee=stripeApiAmountFromLedger(input.feeMinor,input.currency,input.exponent);
  if(wallet+fee!==total||total<=0||total>99999999)return stop();
  const callback=new URL(input.redirectUrl);
  if(callback.username||callback.password||callback.hash|| (callback.protocol!=='https:'&&!(callback.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(callback.hostname))))return stop();
  const metadata={vaydu_driver_topup:input.reference,vaydu_merchant:this.merchant,vaydu_account:account,vaydu_total:String(total)};
  const request=Object.freeze({provider:'stripe',reference:input.reference,merchantAccountRef:this.merchant,providerAccountId:account,
    currency:input.currency,amountMinor:input.amountMinor,exponent:input.exponent,credentialFingerprint:this.fingerprint});
  if(!await this.store.begin(input.reference,request))return stop();
  try{
   // In-app Stripe Elements flow: a PaymentIntent the client confirms
   // server-side-verified — never a browser return alone.
   const pi=await this.stripe.paymentIntents.create({
    amount:total,currency:input.currency.toLowerCase(),metadata,
    payment_method_types:['card'],confirm:false,
   } as Stripe.PaymentIntentCreateParams,{idempotencyKey:'driver-topup:'+input.reference});
   if(pi.livemode!==false||pi.amount!==total||pi.currency!==input.currency.toLowerCase()
    ||pi.metadata?.vaydu_driver_topup!==input.reference||pi.metadata?.vaydu_account!==account
    ||pi.metadata?.vaydu_merchant!==this.merchant||pi.metadata?.vaydu_total!==String(total)||!pi.client_secret)return stop();
   await this.store.finish(input.reference,'submitted',undefined,pi.id);
   return {providerReference:input.reference,clientSecret:pi.client_secret};
  }catch{
   await this.store.finish(input.reference,'unknown');return stop();
  }
 }
 /** Returns the ORIGINAL PaymentIntent's client secret so an unpaid attempt can
  * be completed after a reload. Read-only: never creates or confirms a payment.
  * nextAction=true means the PaymentIntent is waiting for customer authentication
  * (3D Secure): the client must finish that action, not collect a new card. */
 async resume(input:DriverCardExpected):Promise<{clientSecret:string;nextAction:boolean}>{
  const account=await this.account(input),stored=await this.storedAttempt(input,account);
  const id=stored.providerSessionId;
  if(typeof id!=='string'||!id.startsWith('pi_'))throw new PaymentLayerError('PAYMENT_RESUME_UNAVAILABLE','This payment cannot be resumed');
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  const pi=await this.stripe.paymentIntents.retrieve(id);
  if(!this.piIdentity(pi,input,account,total))return stop();
  if(!['requires_payment_method','requires_confirmation','requires_action'].includes(pi.status)||!pi.client_secret)throw new PaymentLayerError('PAYMENT_RESUME_UNAVAILABLE','This payment cannot be resumed');
  return {clientSecret:pi.client_secret,nextAction:pi.status==='requires_action'};
 }
 private sessionIdentity(session:Stripe.Checkout.Session,input:DriverCardExpected,account:string,total:number){
  return session.livemode===false&&session.mode==='payment'&&session.client_reference_id===input.reference
   &&session.metadata?.vaydu_driver_topup===input.reference&&session.metadata?.vaydu_account===account
   &&session.metadata?.vaydu_merchant===this.merchant&&session.metadata?.vaydu_total===String(total)
   &&session.amount_total===total&&session.currency===input.currency.toLowerCase();
 }
 private piIdentity(pi:Stripe.PaymentIntent,input:DriverCardExpected,account:string,total:number){
  return pi.livemode===false&&pi.amount===total&&pi.currency===input.currency.toLowerCase()
   &&pi.metadata?.vaydu_driver_topup===input.reference&&pi.metadata?.vaydu_account===account
   &&pi.metadata?.vaydu_merchant===this.merchant&&pi.metadata?.vaydu_total===String(total);
 }
 private async storedAttempt(input:DriverCardExpected,account:string){
  const stored=await this.store.get(input.reference),req=stored?.request;
  if(!stored||!['submitted','unknown'].includes(stored.state)||!req||req.provider!=='stripe'||req.reference!==input.reference||req.merchantAccountRef!==this.merchant||req.providerAccountId!==account||req.currency!==input.currency||req.amountMinor!==input.amountMinor||req.exponent!==input.exponent||req.credentialFingerprint!==this.fingerprint)return stop();
  return stored;
 }
 /** Cancels the ORIGINAL unpaid payment at Stripe so it can never succeed later.
  * Only unpaid states are cancelled; a paid or processing payment is refused so
  * the caller verifies (and credits) it instead. */
 async cancel(input:DriverCardExpected):Promise<{status:'canceled'}>{
  const account=await this.account(input),stored=await this.storedAttempt(input,account);
  const id=stored.providerSessionId;
  const notDiscardable=()=>{throw new PaymentLayerError('PAYMENT_NOT_DISCARDABLE','Payment is paid or still processing; verify it instead');};
  if(typeof id!=='string'||!(id.startsWith('pi_')||id.startsWith('cs_')))throw new PaymentLayerError('PAYMENT_DISCARD_UNAVAILABLE','This payment cannot be discarded automatically');
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  let piId:string|undefined=id.startsWith('pi_')?id:undefined;
  if(id.startsWith('cs_')){
   let s=await this.stripe.checkout.sessions.retrieve(id);
   if(!this.sessionIdentity(s,input,account,total))return stop();
   if(s.status==='complete')return notDiscardable();
   if(s.status==='open'){s=await this.stripe.checkout.sessions.expire(id);if(s.status!=='expired')return stop();}
   piId=typeof s.payment_intent==='string'?s.payment_intent:s.payment_intent?.id;
   if(!piId){await this.store.observe?.(input.reference,{source:'server-query',provider:'stripe',reference:input.reference,currency:input.currency,status:'expired',providerAccountId:account});return {status:'canceled'};}
  }
  let pi=await this.stripe.paymentIntents.retrieve(piId!);
  if(!this.piIdentity(pi,input,account,total))return stop();
  if(['requires_payment_method','requires_confirmation','requires_action'].includes(pi.status))
   pi=await this.stripe.paymentIntents.cancel(pi.id,{cancellation_reason:'abandoned'},{idempotencyKey:'driver-topup-cancel:'+input.reference});
  if(pi.status!=='canceled')return pi.status==='succeeded'||pi.status==='processing'||pi.status==='requires_capture'?notDiscardable():stop();
  // Audit: same evidence contract as verify (record_driver_topup_provider_observation accepts only these fields).
  await this.store.observe?.(input.reference,{source:'server-query',provider:'stripe',reference:input.reference,currency:pi.currency.toUpperCase(),status:pi.status,providerAccountId:account});
  return {status:'canceled'};
 }
 async verify(input:DriverCardExpected){
  const account=await this.account(input),stored=await this.store.get(input.reference),req=stored?.request;
  if(!stored||!['started','submitted','unknown'].includes(stored.state)||!req||req.provider!=='stripe'||req.reference!==input.reference||req.merchantAccountRef!==this.merchant||req.providerAccountId!==account||req.currency!==input.currency||req.amountMinor!==input.amountMinor||req.exponent!==input.exponent||req.credentialFingerprint!==this.fingerprint)return stop();
  let sessionId=stored.providerSessionId;
  if(!sessionId){
   // Read-only bounded lookup after a lost create response. Never create again.
   let cursor:string|undefined;const matches:Stripe.Checkout.Session[]=[];
   for(let page=0;page<10;page++){
    const list=await this.stripe.checkout.sessions.list({limit:100,...(cursor?{starting_after:cursor}:{})});
    matches.push(...list.data.filter(s=>s.client_reference_id===input.reference&&s.metadata?.vaydu_driver_topup===input.reference));
    if(!list.has_more)break;
    if(page===9)return stop();cursor=list.data.at(-1)?.id;if(!cursor)return stop();
   }
   if(matches.length===1)sessionId=matches[0].id;
   else{
    const search=await this.stripe.paymentIntents.search({query:`metadata["vaydu_driver_topup"]:"${input.reference}"`,limit:5});
    const piMatches=(search.data||[]).filter((p:Stripe.PaymentIntent)=>p.metadata?.vaydu_driver_topup===input.reference);
    if(piMatches.length!==1)return stop();sessionId=piMatches[0].id;
   }
  }
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  let session:Stripe.Checkout.Session|null=null;
  let pi:Stripe.PaymentIntent;
  if(sessionId!.startsWith('pi_')){
   pi=await this.stripe.paymentIntents.retrieve(sessionId!,{expand:['latest_charge.balance_transaction']});
  }else{
   session=await this.stripe.checkout.sessions.retrieve(sessionId!);
   const piId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
   if(!piId){
    // Checkout Sessions create their PaymentIntent lazily: none means nothing was paid.
    if(!this.sessionIdentity(session,input,account,total))return stop();
    if(session.status==='open')throw new PaymentLayerError('PAYMENT_NOT_COMPLETED','Payment has not been completed');
    if(session.status==='expired')throw new PaymentLayerError('PAYMENT_CANCELLED','Payment was cancelled');
    return stop();
   }
   pi=await this.stripe.paymentIntents.retrieve(piId,{expand:['latest_charge.balance_transaction']});
  }
  const charge=typeof pi.latest_charge==='object'?pi.latest_charge:null;
  const balance=charge&&typeof charge.balance_transaction==='object'?charge.balance_transaction:null;
  if(this.store.observe)await this.store.observe(input.reference,{source:'server-query',provider:'stripe',reference:session?.client_reference_id||input.reference,
   currency:(session?.currency||pi.currency||'').toUpperCase(),status:pi.status,providerAccountId:account,paymentMethod:charge?.payment_method_details?.type??null,
   chargedAmountApiMinor:charge?String(charge.amount):null,providerFeeApiMinor:balance?String(balance.fee):null,
   settlementNetApiMinor:balance?String(balance.net):null,settlementCurrency:balance?.currency.toUpperCase()??null,
   providerBalanceReference:balance?.id??null});
  // Identity first: a PaymentIntent that is not provably this attempt (test mode,
  // account, merchant, reference, total, currency) always requires reconciliation.
  const identityOk=this.piIdentity(pi,input,account,total)&&(!session||this.sessionIdentity(session,input,account,total));
  if(!identityOk)return stop();
  // Non-success states of the matching PaymentIntent are reported explicitly so
  // the client can show an accurate state. None of them credits; unknown
  // statuses still fail closed as reconciliation.
  if(pi.status!=='succeeded')return notSucceeded(pi);
  const sessionOk=session?(session.status==='complete'&&session.payment_status==='paid'):true;
  if(!sessionOk||pi.amount_received!==total||!charge||charge.paid!==true||charge.captured!==true||charge.refunded||charge.amount_refunded!==0||charge.amount!==total||charge.currency!==input.currency.toLowerCase()||charge.payment_method_details?.type!=='card')return stop();
  if(!stored.providerSessionId)await this.store.finish(input.reference,'submitted',undefined,sessionId);
  return {reference:input.reference,merchantAccountRef:this.merchant,currency:input.currency,chargedAmountMinor:input.amountMinor,finalStatus:'succeeded' as const};
 }
}
