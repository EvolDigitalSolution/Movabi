import {Router} from 'express';
import {SubaccountListError} from '../services/payments/flutterwave-collection-subaccount';
import {supabaseAdmin} from '../services/supabase.service';
import {DriverPaymentAccountService,sandboxPayoutProvider} from '../services/driver-payment-account.service';
import {timingSafeEqual} from 'node:crypto';
import {JobPayoutService} from '../services/job-payout.service';
import rateLimit from 'express-rate-limit';
import {DriverCollectionAccountService} from '../services/driver-collection-account.service';
export function driverPaymentAccountRouter(db:any=supabaseAdmin,service:any=new DriverCollectionAccountService(db,new DriverPaymentAccountService(db,sandboxPayoutProvider)),options:{collectionOnly?:boolean}={}){
 const router=Router();
 // v3 callbacks are hints only. Persisted queue terms and provider lookup determine settlement.
 if(!options.collectionOnly)router.post('/webhook',async(req,res)=>{
  const secret=process.env.FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET||'';const header=req.headers['verif-hash'];
  if(secret.length<32||secret===process.env.FLUTTERWAVE_TEST_SECRET_KEY||typeof header!=='string'||Buffer.byteLength(secret)!==Buffer.byteLength(header)
   ||!timingSafeEqual(Buffer.from(secret),Buffer.from(header)))return void res.sendStatus(401);
  const match=/^vaydu-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_PMCK$/.exec(String(req.body?.data?.reference||''));
  if(!match)return void res.sendStatus(202);
  try{
   sandboxPayoutProvider();
   const queued=await db.from('job_payout_queue').select('job_id').eq('job_id',match[1]).eq('terms->>payout_provider','flutterwave').maybeSingle();
   if(queued.error)return void res.sendStatus(503);
   if(queued.data)await JobPayoutService.process(match[1]);res.sendStatus(202);
  }catch{res.sendStatus(503);}
 });
 router.use(rateLimit({windowMs:60000,max:20,standardHeaders:true,legacyHeaders:false,message:{error:'Please wait before retrying payment account setup.'}}));
 router.use(async(req,res,next)=>{
  try{const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
   if(!token)return void res.status(401).json({error:'Sign in required.'});
   const result=await db.auth.getUser(token);if(result.error||!result.data?.user)return void res.status(401).json({error:'Sign in required.'});
   res.locals.driverId=result.data.user.id;next();
  }catch{res.status(401).json({error:'Sign in required.'});}
 });
 const handler=(fn:(req:any,id:string)=>Promise<any>)=>async(req:any,res:any)=>{
  res.setHeader('Cache-Control','no-store');
  try{res.json(await fn(req,res.locals.driverId));}catch(error){if(error instanceof SubaccountListError){res.status(409).json({error:'Setup lookup could not be verified. Retry the status check only.',errorCode:'SUBACCOUNT_LIST_'+error.category.toUpperCase(),reconcileOnly:true});return;}res.status(409).json({error:'Payment account request could not be verified. Refresh, check the details and retry.'});}
 };
 router.get('/status',handler((_,id)=>service.status(id)));
 router.get('/banks',handler(async(_,id)=>({banks:await service.banks(id)})));
 router.post('/resolve',handler(async(req,id)=>({accountName:await service.resolve(id,String(req.body?.accountType||'bank'),String(req.body?.bankCode||''),String(req.body?.accountNumber||''))})));
 router.post('/setup',handler((req,id)=>req.body?.confirmed===true?service.setup(id,{
  name:String(req.body?.name||''),email:String(req.body?.email||''),phone:String(req.body?.phone||''),accountType:req.body?.accountType||'bank',
  bankCode:String(req.body?.bankCode||''),accountNumber:String(req.body?.accountNumber||''),confirmedName:String(req.body?.accountName||'')
 }):Promise.reject(new Error('Confirmation required.'))));
 router.post('/reconcile',handler((_,id)=>service.reconcile(id)));
 return router;
}
export default driverPaymentAccountRouter();
