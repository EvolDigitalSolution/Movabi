// Local runtime fixture only; never copied into the production API payload.
const express=require('express'),{createClient}=require('@supabase/supabase-js');
const app=express();app.use(express.json());
require('/app/server/payment-account-closure/mount.cjs')(app,{db:createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})});
app.get('/health',(_,res)=>res.json({status:'ok'}));app.listen(3001);
