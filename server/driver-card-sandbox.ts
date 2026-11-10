import express from 'express';
import cors from 'cors';
import driverWalletTopupRoutes from './routes/driver-wallet-topup.routes';

/** Dedicated develop-only process; never changes the shared API's NODE_ENV. */
export function createDriverCardSandbox(env:NodeJS.ProcessEnv=process.env){
 if(env['VAYDU_SANDBOX_DEPLOYMENT']!=='develop'||!['test','development'].includes(env['NODE_ENV']||'')||env['VAYDU_SANDBOX_WEB_ORIGIN']!=='https://movabi-develop.apps.evolsolution.com')throw Error('Dedicated develop sandbox configuration required');
 if(env['SUPABASE_URL']&&!['movabi-develop-kong','movabi-supabase-develop.apps.evolsolution.com'].includes(new URL(env['SUPABASE_URL']).hostname))throw Error('Only the verified develop Supabase target is allowed');
 if((env['STRIPE_SECRET_KEY']&&!/^sk_test_[A-Za-z0-9_]+$/.test(env['STRIPE_SECRET_KEY']))||(env['FLUTTERWAVE_SECRET_KEY']&&!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(env['FLUTTERWAVE_SECRET_KEY'])))throw Error('Only test provider credentials may enter this process');
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'8kb'}));
 app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');const origin=req.headers.origin;if(origin&&origin!==env['VAYDU_SANDBOX_WEB_ORIGIN']&&!['http://localhost:3000','https://localhost','capacitor://localhost'].includes(origin))return res.status(403).json({code:'SANDBOX_ORIGIN_REJECTED'});return next();});
 app.use(cors({origin:[env['VAYDU_SANDBOX_WEB_ORIGIN'],'http://localhost:3000','https://localhost','capacitor://localhost'],methods:['GET','POST','OPTIONS'],allowedHeaders:['Authorization','Content-Type']}));
 app.get('/health',(_req,res)=>res.json({sandbox:true,liveCredentialsAllowed:false}));
 app.use('/api/payment/driver-topup',driverWalletTopupRoutes());
 return app;
}
if(require.main===module){
 try{createDriverCardSandbox().listen(3021,'0.0.0.0',()=>console.log('Dedicated develop card sandbox listening on 3021'));}
 catch{console.error('Dedicated sandbox configuration rejected');process.exitCode=1;}
}
