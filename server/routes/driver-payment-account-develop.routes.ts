import existingRoutes,{driverPaymentAccountRouter} from './driver-payment-account.routes';
import {supabaseAdmin} from '../services/supabase.service';
import {DriverPaymentAccountService,sandboxDestinationProvider} from '../services/driver-payment-account.service';
import {DriverCollectionAccountService,SETUP_ONLY_COLLECTION_STORE} from '../services/driver-collection-account.service';
import {confirmedDevelopCollectionScope,developCollectionProvider} from '../services/payments/flutterwave-collection-develop';
import {driverPaymentAccountRouter as setupRouter} from '../payment-account-closure/router';
import {SetupService} from '../payment-account-closure/service';
import {resolve as resolvePath} from 'node:path';
import {Router} from 'express';

/** Same object for auth, scope, reads and durable claims. No second createClient or DB transport. */
export function developDriverPaymentAccountRouter(db:any=supabaseAdmin,env:NodeJS.ProcessEnv=process.env,
 loader?:Parameters<typeof developCollectionProvider>[2],request?:typeof fetch){
 if(env.VAYDU_PAYMENT_ACCOUNT_SETUP!==undefined){
  try{
   const target=new URL(db.supabaseUrl||'').href;
   if(!['http://movabi-develop-kong:8000/','https://movabi-supabase-develop.apps.evolsolution.com/'].includes(target))throw Error('Verified develop database target required.');
   const provider=require(resolvePath(__dirname,'../../deploy/vaydu-payment-account-setup/api/runtime.cjs'))({...env},request);
   const service=new SetupService(db,provider);const router=Router();
   // Per-app bridge for the existing mandatory requirement evaluator. No
   // process-global client, Stripe state, or profile completion flag changes.
   router.use((req,_res,next)=>{req.app.locals.vayduPaymentAccountSetup=service;next();});
   router.use(setupRouter(db,provider));
   return router;
  }catch(e){
   // The test-only credential guard threw. Keep this integration unavailable
   // (controlled 503 + sanitized diagnostic) WITHOUT crashing the whole API.
   const code=(e as Error)?.message||'unknown';
   console.error('[driver-payment-account-setup] integration unavailable:', code);
   const unavailable=Router();
   unavailable.use((_req,res)=>{res.status(503).json({error:'Payment account setup is temporarily unavailable.',code:'PAYMENT_ACCOUNT_SETUP_UNAVAILABLE'});});
   return unavailable;
  }
 }
 if(env.VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP===undefined||env.VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP==='false')return existingRoutes;
 const provider=developCollectionProvider(db.supabaseUrl,env,loader,request);
 const service=new DriverCollectionAccountService(db,new DriverPaymentAccountService(db,sandboxDestinationProvider,true),provider,confirmedDevelopCollectionScope,SETUP_ONLY_COLLECTION_STORE);
 return driverPaymentAccountRouter(db,service,{collectionOnly:true});
}
