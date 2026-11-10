import {sandboxSubaccountProvider} from './services/payments/flutterwave-collection-subaccount';
import {flutterwaveBookingSplitRouter} from './routes/flutterwave-booking-split.routes';
import express from 'express';
import cors from 'cors';
import {driverPaymentAccountRouter} from './routes/driver-payment-account.routes';
import {sandboxPayoutProvider,sandboxDestinationProvider} from './services/driver-payment-account.service';
import {JobPayoutService} from './services/job-payout.service';
import {supabaseAdmin} from './services/supabase.service';
import {DriverPaymentAccountService} from './services/driver-payment-account.service';
import {DriverCollectionAccountService} from './services/driver-collection-account.service';
import {FlutterwaveBookingSplitService,bookingSplitProvider} from './services/flutterwave-booking-split.service';

/** Isolated develop subaccount/split runtime; no wallet top-up, cash or Stripe worker. */
export function createDriverPaymentAccountSandbox(){
 if(process.env.VAYDU_DRIVER_SUBACCOUNT_SANDBOX==='true')sandboxSubaccountProvider();else sandboxPayoutProvider();
 const target=new URL(process.env.SUPABASE_URL||'');
 if(!['movabi-develop-kong','movabi-supabase-develop.apps.evolsolution.com'].includes(target.hostname))throw Error('Verified develop database target required.');
 const stripe=process.env.STRIPE_SECRET_KEY;
 if(stripe&&!stripe.startsWith('sk_test_'))throw Error('Live credentials forbidden in sandbox.');
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'4kb'}));
 const origins=['https://movabi-develop.apps.evolsolution.com','http://localhost:3000','https://localhost','capacitor://localhost'];
 app.use((req,res,next)=>req.headers.origin&&!origins.includes(req.headers.origin)?void res.sendStatus(403):next());
 app.use(cors({origin:origins,methods:['GET','POST','OPTIONS'],allowedHeaders:['Authorization','Content-Type']}));
 app.get('/health',(_req,res)=>res.json({sandbox:true,provider:'flutterwave',livePayouts:false}));
 app.use('/api/driver-payment-account',driverPaymentAccountRouter());
 app.use('/api/payment/flutterwave-booking-split',flutterwaveBookingSplitRouter());
 return app;
}
export async function reconcileSandboxPayouts(){
 sandboxPayoutProvider();
 const result=await supabaseAdmin.from('job_payout_queue').select('job_id').eq('terms->>payout_provider','flutterwave')
  .in('status',['pending','processing','reconcile']).lte('retry_at',new Date().toISOString()).limit(20);
 if(result.error)throw Error('Sandbox payout queue unavailable.');
 for(const q of result.data||[])await JobPayoutService.process(q.job_id);
}
let splitReconciliationRunning=false;
export async function reconcileSandboxSplits(){
 if(splitReconciliationRunning)return;
 // Read/verify only. This worker never creates a checkout or switches settlement methods.
 bookingSplitProvider(process.env.FLUTTERWAVE_COLLECTION_MERCHANT_REF||'');splitReconciliationRunning=true;
 try{
  const rows=await supabaseAdmin.from('job_settlement_methods').select('job_id,terms,state').eq('method','split')
   .in('state',['submitting','checkout','collected']).order('created_at').limit(20);
  if(rows.error)throw Error('Split queue unavailable.');
  const service=new FlutterwaveBookingSplitService(supabaseAdmin,new DriverCollectionAccountService(supabaseAdmin,new DriverPaymentAccountService(supabaseAdmin,sandboxDestinationProvider)));
  for(const row of rows.data||[]){
   try{if(row.state!=='collected')await service.verify(row.terms.customerId,row.job_id);await service.settlement(row.terms.customerId,row.job_id);}
   catch{/* Pending/unknown outcomes retain the same frozen reference for the next lookup. */}
  }
 }finally{splitReconciliationRunning=false;}
}
if(require.main===module){
 try{
  createDriverPaymentAccountSandbox().listen(3022,'0.0.0.0',()=>console.log('Develop payment-account sandbox listening on 3022'));
  if(process.env.VAYDU_DRIVER_PAYOUT_TRANSFERS==='true'){const timer=setInterval(()=>{void reconcileSandboxPayouts().catch(()=>console.error('Sandbox payout reconciliation unavailable.'));},60000);timer.unref();}
  if(process.env.VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX==='true'&&process.env.VAYDU_BOOKING_SPLIT_TIMING_APPROVED==='true'){
   const timer=setInterval(()=>{void reconcileSandboxSplits().catch(()=>console.error('Sandbox split reconciliation unavailable.'));},60000);timer.unref();
  }
 }catch{console.error('Payment-account sandbox configuration rejected.');process.exitCode=1;}
}
