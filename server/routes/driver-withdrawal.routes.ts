import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {supabaseAdmin} from '../services/supabase.service';
import {DriverWithdrawalService} from '../services/driver-withdrawal.service';

/**
 * Driver earnings-wallet withdrawals (NG/NGN sandbox scope).
 * POST reserves spendable earnings into a held purpose before any provider
 * contact; the worker settles or reverses on a verified provider outcome.
 */
export function driverWithdrawalRouter(db:any=supabaseAdmin){
 const router=Router();
 router.use(rateLimit({windowMs:60000,max:20,standardHeaders:true,legacyHeaders:false,message:{error:'Please wait before retrying.'}}));
 router.use(async(req,res,next)=>{
  try{const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
   if(!token)return void res.status(401).json({error:'Sign in required.'});
   const result=await db.auth.getUser(token);if(result.error||!result.data?.user)return void res.status(401).json({error:'Sign in required.'});
   res.locals.driverId=result.data.user.id;next();
  }catch{res.status(401).json({error:'Sign in required.'});}
 });
 router.get('/',async(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const {data,error}=await db.from('driver_withdrawals').select('id,status,amount_minor,currency_code,reference,last_error,created_at,updated_at')
    .eq('driver_id',res.locals.driverId).order('created_at',{ascending:false}).limit(50);
   if(error)throw error;return res.json({withdrawals:data||[]});
  }catch{return res.status(503).json({error:'Withdrawal history is temporarily unavailable.'});}
 });
 router.get('/balance',async(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const {data:profile,error}=await db.from('profiles').select('tenant_id,country_code,registration_country_code').eq('id',res.locals.driverId).maybeSingle();
   if(error||!profile)return res.status(403).json({error:'Driver access required.'});
   const country=String(profile.registration_country_code||profile.country_code||'').toUpperCase();
   const currency=country==='NG'?'NGN':null;
   if(!currency)return res.json({withdrawableMinor:0,currency:null});
   const {data,error:balanceError}=await db.rpc('driver_earnings_wallet_balance',{p_driver:res.locals.driverId,p_tenant:profile.tenant_id,p_currency:currency});
   if(balanceError)throw balanceError;
   return res.json({withdrawableMinor:Number(data||0),currency});
  }catch{return res.status(503).json({error:'Withdrawable balance is temporarily unavailable.'});}
 });
 router.post('/',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const amount=Number(req.body?.amountMinor);
   if(!Number.isSafeInteger(amount)||amount<=0)return res.status(400).json({error:'A positive withdrawal amount is required.'});
   const {data,error}=await db.rpc('request_driver_withdrawal',{p_driver:res.locals.driverId,p_amount_minor:amount});
   if(error){
    const message=String(error.message||'');
    if(/exceeds the withdrawable/.test(message))return res.status(409).json({error:'Withdrawal exceeds the withdrawable earnings balance.',errorCode:'WITHDRAWAL_EXCEEDS_BALANCE'});
    if(/Approved payout destination|positive withdrawal/.test(message))return res.status(409).json({error:'A verified payout account is required before withdrawing.',errorCode:'WITHDRAWAL_DESTINATION_REQUIRED'});
    throw error;
   }
   // Kick the worker so a sandbox withdrawal settles promptly; the durable
   // reservation already holds the funds regardless of worker timing.
   void DriverWithdrawalService.process(data.id).catch(()=>{});
   return res.status(202).json({id:data.id,status:data.status,reference:data.reference});
  }catch{return res.status(503).json({error:'Withdrawal request could not be verified. Check status before retrying.'});}
 });
 return router;
}
export default driverWithdrawalRouter();
