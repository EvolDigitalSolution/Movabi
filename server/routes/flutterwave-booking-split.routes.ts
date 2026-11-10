import {Router} from 'express';
import {supabaseAdmin} from '../services/supabase.service';
import {DriverPaymentAccountService,sandboxPayoutProvider} from '../services/driver-payment-account.service';
import {DriverCollectionAccountService} from '../services/driver-collection-account.service';
import {FlutterwaveBookingSplitService} from '../services/flutterwave-booking-split.service';
export function flutterwaveBookingSplitRouter(db:any=supabaseAdmin,service=new FlutterwaveBookingSplitService(db,new DriverCollectionAccountService(db,new DriverPaymentAccountService(db,sandboxPayoutProvider)))){
 const router=Router();
 router.use(async(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');try{
   const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];if(!token)return void res.sendStatus(401);
   const user=await db.auth.getUser(token);if(user.error||!user.data?.user)return void res.sendStatus(401);
   res.locals.customer=user.data.user;next();
  }catch{res.sendStatus(401);}
 });
 const route=(fn:(req:any,user:any)=>Promise<any>)=>async(req:any,res:any)=>{try{res.json(await fn(req,res.locals.customer));}catch{res.status(409).json({error:'Booking split request needs verification or reconciliation. No alternative settlement was submitted.'});}};
 router.post('/quote',route(async(req,u)=>(await service.quote(u.id,String(req.body?.jobId||''))).public));
 router.post('/checkout',route((req,u)=>service.checkout(u.id,String(req.body?.jobId||''),u.email||'',req.body?.confirmedTotalMinor)));
 router.post('/verify',route((req,u)=>service.verify(u.id,String(req.body?.jobId||''))));
 router.post('/settlement',route((req,u)=>service.settlement(u.id,String(req.body?.jobId||''))));
 return router;
}
export default flutterwaveBookingSplitRouter();
