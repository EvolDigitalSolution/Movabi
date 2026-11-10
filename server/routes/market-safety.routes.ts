import {DriverCollectionAccountService} from '../services/driver-collection-account.service';
import {DriverPaymentAccountService,sandboxDestinationProvider} from '../services/driver-payment-account.service';
import { readDriverCashCredit, mapCashCreditError } from '../services/driver-cash-credit';
import {driverMatchesJobMarket} from '../services/driver-market-scope';
import {Router} from 'express';
import {supabaseAdmin as db} from '../services/supabase.service';
import {MarketAvailabilityService} from '../services/market-availability.service';
import {readDatabasePaymentAssignment} from '../services/payments/market-payment-store';
import {PayoutEligibilityService} from '../services/payout-eligibility.service';
import {stripeCheckoutMarket,bookingQuoteState,driverWalletPayoutState} from '../services/booking-payment-context';
const router=Router();
router.use(async(req,res,next)=>{
 res.setHeader('Cache-Control','private, no-store');
 try{const header=String(req.headers.authorization||'');if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({error:'Please sign in again.'});
 const {data,error}=await db.auth.getUser(header.replace(/^Bearer\s+/i,''));if(error||!data?.user)return res.status(401).json({error:'Please sign in again.'});(req as any).marketUserId=data.user.id;next();
 }catch{return res.status(503).json({error:'Market authentication unavailable.'});}
});
router.get('/booking/:jobId',async(req,res)=>{
 try{
 const {data:job,error}=await db.from('jobs').select('*').eq('id',String(req.params.jobId)).maybeSingle();
 if(error)throw error;if(!job||job.customer_id!==(req as any).marketUserId)return res.status(404).json({error:'Booking unavailable.'});
 const country=String(job.country_code||job.metadata?.country_code||'').toUpperCase(),currency=String(job.currency_code||'').toUpperCase();
 const assignment=await readDatabasePaymentAssignment(db,{country,currency,method:'card'});
 let state=bookingQuoteState(job);
 if(Number(job.agreed_fare)>0&&state!=='expired'){
  const {data:session,error:sessionError}=await db.from('marketplace_negotiation_sessions').select('status,payment_deadline,expires_at').eq('job_id',job.id).maybeSingle();
  const expires=Date.parse(String(session?.payment_deadline||session?.expires_at||''));
  state=!sessionError&&session&&['fare_agreed'].includes(String(session.status))&&Number.isFinite(expires)?(expires>Date.now()?'current':'expired'):'unavailable';
 }
 const scoped=await MarketAvailabilityService.resolveMarket({countryCode:country,marketCity:job.market_city||job.metadata?.market_city});
 const legacy=assignment.provider==='stripe'&&stripeCheckoutMarket(job)&&process.env.VAYDU_GLOBAL_PAYMENT_ROUTING_V23!=='true'&&process.env.VAYDU_DATABASE_PAYMENT_ROUTING_V23!=='true';
 const ready=stripeCheckoutMarket(job)&&(legacy||(assignment.provider==='stripe'&&assignment.routeEnabled&&assignment.merchantApproved&&assignment.adapterReady));
 const enabled=scoped.launchStatus==='live'&&scoped.capabilities.payment;
 const provider=legacy?'stripe':assignment.provider;
 return res.json({...assignment,provider,jobId:job.id,quoteState:state,checkoutAvailable:!!(ready&&enabled&&state==='current'),
  message:state!=='current'?'Get a new quote before payment.':!enabled?'Payments are unavailable in this market.':!ready?'Payment setup for this market is not ready yet.':'Pay securely by card.'});
 }catch{return res.status(503).json({error:'Payment availability could not be verified.'});}
});
// Separate endpoint: legacy wallet and payout response contracts remain intact.
router.get('/driver-cash-credit',async(req,res)=>{
 try {
  const state=await readDriverCashCredit(db,(req as any).marketUserId);
  return res.json(state);
 }catch(error:any){
  const failure=mapCashCreditError(error);
  if(failure)return res.status(failure.status).json({code:failure.code,error:failure.error});
  return res.status(503).json({code:'CASH_CREDIT_UNAVAILABLE',error:'Cash credit status temporarily unavailable.'});
 }});

// Caller-owned cash-credit top-up activity. `state:'credited'` requires a
// wallet_topup_attempts row linked to an existing wallet_business_events
// canonical ledger event — never a browser return or a non-null id alone.
router.get('/driver-cash-credit/activity',async(req,res)=>{
 try{
  const id=(req as any).marketUserId;
  const {data:profile,error:profileError}=await db.from('profiles').select('tenant_id,country_code,registration_country_code').eq('id',id).eq('role','driver').maybeSingle();
  if(profileError)throw profileError;
  if(!profile?.tenant_id)return res.status(403).json({code:'DRIVER_NOT_ELIGIBLE',error:'Driver cash-credit activity is unavailable for this account.'});
  const rawLimit=Number(req.query.limit||20);
  const limit=Number.isInteger(rawLimit)&&rawLimit>0?Math.min(rawLimit,50):20;
  const before=typeof req.query.before==='string'?req.query.before:null;
  // Currency scope follows the canonical cash-credit market authority — not a
  // country->GBP shortcut — so the contract stays market-driven.
  const cashState=await readDriverCashCredit(db,id);
  const currency=(cashState as any)?.balance?.currency||(cashState as any)?.currency||null;
  let q=db.from('wallet_topup_attempts')
   .select('id,owner_id,tenant_id,status,amount_minor,provider_fee_minor,total_charge_minor,provider_reference,currency_code,created_at,credited_event_id,destination_account_purpose')
   .eq('owner_id',id).eq('tenant_id',profile.tenant_id).eq('destination_account_purpose','driver_cash_credit')
   .order('created_at',{ascending:false}).limit(limit+1);
  if(before)q=q.lt('created_at',before);
  if(currency)q=q.eq('currency_code',String(currency));
  const {data:rows,error}=await q;
  if(error)throw error;
  const list=(rows||[]).slice(0,limit);
  const creditedIds=[...new Set(list.map((r:any)=>r.credited_event_id).filter(Boolean))];
  const {data:events}=creditedIds.length?await db.from('wallet_business_events').select('id,owner_id,tenant_id,currency_code,provider_reference').in('id',creditedIds):{data:[]};
  const eventById=new Map((events||[]).map((e:any)=>[e.id,e]));
  const attempts=list.map((r:any)=>{
   // Canonical credit proof: the finalize RPC writes status='credited' AND
   // credited_event_id atomically, and the linked event must be bound to THIS
   // attempt — same owner, tenant, currency and provider reference. An event
   // belonging to a different attempt/owner can never render as credited.
   const ev=eventById.get(r.credited_event_id);
   const bound=!!ev&&ev.owner_id===r.owner_id&&ev.tenant_id===r.tenant_id&&ev.currency_code===r.currency_code
    &&(!r.provider_reference||ev.provider_reference===r.provider_reference);
   const credited=r.status==='credited'&&bound;
   return {id:r.id,status:r.status,amount_minor:r.amount_minor,fee_minor:r.provider_fee_minor??null,total_charge_minor:r.total_charge_minor??null,currency_code:r.currency_code,created_at:r.created_at,
    credited_event_id:credited?r.credited_event_id:null,
    state:credited?'credited':(['succeeded','credited'].includes(r.status)?'pending_confirmation':(r.status||'pending'))};
  });
  const next_cursor=(rows||[]).length>limit?list[list.length-1]?.created_at??null:null;
  return res.json({attempts,next_cursor});
 }catch(error:any){
  const failure=mapCashCreditError(error);
  if(failure)return res.status(failure.status).json({code:failure.code,error:failure.error});
  return res.status(503).json({code:'CASH_CREDIT_UNAVAILABLE',error:'Cash credit activity temporarily unavailable.'});
 }});

router.get('/driver-wallet',async(req,res)=>{
 try{
 const id=(req as any).marketUserId;const {data:profile,error}=await db.from('profiles').select('*').eq('id',id).maybeSingle();
 if(error)throw error;if(!profile||profile.role!=='driver')return res.status(403).json({error:'Driver access required.'});
 const country=String(profile.registration_country_code||profile.country_code||'').toUpperCase();
 const market=await MarketAvailabilityService.resolveMarket({countryCode:country,marketCity:profile.registration_market_city});
 if(!market.currency)return res.status(409).json({error:'Driver market is unresolved.'});
 const assignment=await readDatabasePaymentAssignment(db,{country,currency:market.currency,method:'card'});
 // Current payout adapter remains GB Stripe; collection currency support never enables payouts.
 const stripeSupported=assignment.provider==='stripe'&&country==='GB'&&market.currency==='GBP'&&PayoutEligibilityService.isSupportedCountry(country);
 const eligibility=stripeSupported?await PayoutEligibilityService.evaluateDriver(id):null;
 const accountStatus=country==='NG'?await new DriverCollectionAccountService(db,new DriverPaymentAccountService(db,sandboxDestinationProvider)).status(id):null;
 const {data:activeJobs,error:activeError}=await db.from('jobs').select('id,country_code,tenant_id,metadata')
  .eq('driver_id',id).not('status','in','(completed,settled,cancelled,canceled,expired,failed,no_driver_found)').limit(20);
 if(activeError)throw activeError;
 const {data:leases,error:leaseError}=await db.from('marketplace_negotiation_sessions').select('job_id')
  .eq('active_driver_id',id).in('status',['driver_claimed','negotiating','fare_agreed']).limit(20);
 if(leaseError)throw leaseError;
 const leaseIds=[...new Set((leases||[]).map(row=>row.job_id))];
 const leaseJobs=leaseIds.length?await db.from('jobs').select('id,country_code,tenant_id,metadata').in('id',leaseIds):{data:[],error:null};
 if(leaseJobs.error)throw leaseJobs.error;
 const marketReviewRequired=(leaseJobs.data||[]).length<leaseIds.length||(activeJobs||[]).length>=20||(leases||[]).length>=20||
  [...(activeJobs||[]),...(leaseJobs.data||[])].some(job=>!driverMatchesJobMarket(profile,job));
 return res.json({country,currency:market.currency,marketReviewRequired,provider:stripeSupported?'stripe':assignment.provider,
  ...(accountStatus?{payoutIntegrationAvailable:accountStatus.available,payoutAvailable:false,collectionSetupCompleted:accountStatus.state==='completed',provider:accountStatus.provider,
   status:accountStatus.state==='completed'?'Payment account set up':accountStatus.available?'Payout setup required':'Payout setup pending',
   message:accountStatus.available?'Complete payment account setup to receive earnings.':'Payouts are not activated for this market yet.'}:driverWalletPayoutState(stripeSupported,eligibility))});
 }catch{return res.status(503).json({error:'Payout availability could not be verified.'});}
});
export default router;
