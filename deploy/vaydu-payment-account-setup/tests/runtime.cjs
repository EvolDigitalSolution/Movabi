'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const runtime=require('../api/runtime.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vaydu-setup-runtime-'));
const file=path.join(root,'test.env');
const env={NODE_ENV:'production',VAYDU_DEPLOYMENT_ENV:'develop',VAYDU_PAYMENT_ACCOUNT_SETUP:'true',VAYDU_PAYMENT_ACCOUNT_SECRET_FILE:file,VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF:'fixture-alias'};
function write(key='FLWSECK_TEST-synthetic') {fs.writeFileSync(file,'FLUTTERWAVE_TEST_SECRET_KEY='+key+'\nFLUTTERWAVE_LIVE_SECRET_KEY=\nFLUTTERWAVE_COLLECTION_MERCHANT_REF=fixture-alias\n',{mode:0o600});fs.chmodSync(file,0o600);}
try{
 assert.throws(()=>runtime({})('fixture-alias'));
 write();const snapshot={...process.env};const first=runtime(env,async()=>{throw Error('no calls');});
 assert(first('fixture-alias'));assert.throws(()=>first('other-alias'));assert(JSON.stringify({...process.env})===JSON.stringify(snapshot),'process environment must remain unchanged');
 write('FLWSECK-live-synthetic');assert.throws(()=>runtime(env));
 write();assert.throws(()=>runtime({...env,VAYDU_DRIVER_PAYOUT_TRANSFERS:'true'}));
 assert.throws(()=>runtime({...env,VAYDU_DEPLOYMENT_ENV:'production'}));
 assert.throws(()=>runtime({...env,VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF:'different'}));
 // Captured clients cannot acquire another instance's later binding or key.
 assert(first('fixture-alias'));assert.equal(env.NODE_ENV,'production');
 console.log(JSON.stringify({completed:true,testOnly:true,disabledDefault:true,productionNodeEnvPreserved:true,instanceIsolation:true,transfersBlocked:true}));
}finally{fs.rmSync(root,{recursive:true});}
