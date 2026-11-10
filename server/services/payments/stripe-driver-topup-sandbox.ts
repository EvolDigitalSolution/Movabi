import type Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {PaymentLayerError} from './payment-contracts';
import {stripeApiAmountFromLedger} from './stripe-currency-amounts';
import type {DriverCardAttemptStore,DriverCardExpected,DriverCardInput,DriverCardTopupAdapter} from './driver-card-topup-contracts';

const stop=():never=>{throw new PaymentLayerError('PAYMENT_RECONCILIATION_REQUIRED','Verify the original sandbox payment');};
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
   if(!piId)return stop();
   pi=await this.stripe.paymentIntents.retrieve(piId,{expand:['latest_charge.balance_transaction']});
  }
  const charge=typeof pi.latest_charge==='object'?pi.latest_charge:null;
  const balance=charge&&typeof charge.balance_transaction==='object'?charge.balance_transaction:null;
  if(this.store.observe)await this.store.observe(input.reference,{source:'server-query',provider:'stripe',reference:session?.client_reference_id||input.reference,
   currency:(session?.currency||pi.currency||'').toUpperCase(),status:pi.status,providerAccountId:account,paymentMethod:charge?.payment_method_details?.type??null,
   chargedAmountApiMinor:charge?String(charge.amount):null,providerFeeApiMinor:balance?String(balance.fee):null,
   settlementNetApiMinor:balance?String(balance.net):null,settlementCurrency:balance?.currency.toUpperCase()??null,
   providerBalanceReference:balance?.id??null});
  const sessionOk=session?(session.livemode===false&&session.mode==='payment'&&session.status==='complete'&&session.payment_status==='paid'&&session.client_reference_id===input.reference&&session.metadata?.vaydu_driver_topup===input.reference&&session.metadata?.vaydu_account===account&&session.metadata?.vaydu_merchant===this.merchant&&session.metadata?.vaydu_total===String(total)&&session.amount_total===total&&session.currency===input.currency.toLowerCase()):true;
  if(!sessionOk||pi.livemode!==false||pi.status!=='succeeded'||pi.amount!==total||pi.amount_received!==total||pi.currency!==input.currency.toLowerCase()||pi.metadata?.vaydu_driver_topup!==input.reference||pi.metadata?.vaydu_account!==account||pi.metadata?.vaydu_merchant!==this.merchant||pi.metadata?.vaydu_total!==String(total)||!charge||charge.paid!==true||charge.captured!==true||charge.refunded||charge.amount_refunded!==0||charge.amount!==total||charge.currency!==input.currency.toLowerCase()||charge.payment_method_details?.type!=='card')return stop();
  if(!stored.providerSessionId)await this.store.finish(input.reference,'submitted',undefined,sessionId);
  return {reference:input.reference,merchantAccountRef:this.merchant,currency:input.currency,chargedAmountMinor:input.amountMinor,finalStatus:'succeeded' as const};
 }
 async recover(input:DriverCardExpected):Promise<{status:string;clientSecret?:string}>{
  const account=await this.account(input),stored=await this.store.get(input.reference),req=stored?.request;
  if(!stored||!['started','submitted','unknown'].includes(stored.state)||!req||req.provider!=='stripe'||req.reference!==input.reference||req.merchantAccountRef!==this.merchant||req.providerAccountId!==account||req.currency!==input.currency||req.amountMinor!==input.amountMinor||req.exponent!==input.exponent||req.credentialFingerprint!==this.fingerprint)return {status:'unknown'};
  let sessionId=stored.providerSessionId;
  if(!sessionId){
   const search=await this.stripe.paymentIntents.search({query:`metadata["vaydu_driver_topup"]:"${input.reference}"`,limit:5});
   const piMatches=(search.data||[]).filter((p:Stripe.PaymentIntent)=>p.metadata?.vaydu_driver_topup===input.reference);
   if(piMatches.length!==1)return {status:'unknown'};sessionId=piMatches[0].id;
  }
  const total=stripeApiAmountFromLedger(input.amountMinor,input.currency,input.exponent);
  let pi:Stripe.PaymentIntent;
  if(sessionId!.startsWith('pi_')){
   pi=await this.stripe.paymentIntents.retrieve(sessionId!,{expand:['latest_charge.balance_transaction']});
  }else{
   const session=await this.stripe.checkout.sessions.retrieve(sessionId!);
   const piId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
   if(!piId)return {status:'unknown'};
   pi=await this.stripe.paymentIntents.retrieve(piId,{expand:['latest_charge.balance_transaction']});
  }
  if(!pi||pi.livemode!==false||pi.amount!==total||pi.currency!==input.currency.toLowerCase()||pi.metadata?.vaydu_driver_topup!==input.reference||pi.metadata?.vaydu_account!==account||pi.metadata?.vaydu_merchant!==this.merchant||pi.metadata?.vaydu_total!==String(total))return {status:'unknown'};
  if(pi.status==='succeeded')return {status:'succeeded'};
  if(pi.status==='processing')return {status:'processing'};
  if(['requires_payment_method','requires_confirmation','requires_action','requires_capture'].includes(pi.status))return {status:pi.status,clientSecret:pi.client_secret||undefined};
  return {status:pi.status};
 }
}
