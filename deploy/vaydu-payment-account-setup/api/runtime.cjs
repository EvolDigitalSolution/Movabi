'use strict';
const fs=require('node:fs');
const {createHmac}=require('node:crypto');
const {FlutterwaveDriverPayout}=require('./services/payments/flutterwave-driver-payout.js');
// Capture configuration once per mount. Do not modify process.env or share clients.
module.exports=function runtime(env,request=fetch){
 if(env.VAYDU_PAYMENT_ACCOUNT_SETUP!=='true')return ()=>{throw Error('setup_disabled');};
 if(env.VAYDU_DEPLOYMENT_ENV!=='develop')throw Error('develop_opt_in_required');
 for(const flag of ['VAYDU_DRIVER_PAYOUT_TRANSFERS','VAYDU_DRIVER_SUBACCOUNT_SANDBOX','VAYDU_FLUTTERWAVE_BOOKING_SPLIT_SANDBOX']){
  if(env[flag]==='true')throw Error('setup_only_flags_required');
 }
 const path=env.VAYDU_PAYMENT_ACCOUNT_SECRET_FILE;
 if(!path||!require('node:path').isAbsolute(path)||fs.lstatSync(path).isSymbolicLink())throw Error('private_binding_required');
 const stat=fs.statSync(path);
 if(!stat.isFile()||(stat.mode&0o077)!==0)throw Error('private_binding_permissions_required');
 const values={};for(const line of fs.readFileSync(path,'utf8').split(/\r?\n/)){
  if(!line.trim()||line.trim().startsWith('#'))continue;
  const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!match)throw Error('invalid_binding_format');
  if(Object.hasOwn(values,match[1]))throw Error('duplicate_binding');
  let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  values[match[1]]=value;
 }
 if(values.FLUTTERWAVE_LIVE_SECRET_KEY||values.FLUTTERWAVE_SECRET_KEY||!/^FLWSECK_TEST-/.test(values.FLUTTERWAVE_TEST_SECRET_KEY||''))throw Error('test_only_binding_required');
 // Existing setup-file reference is an internal binding, not an asserted MID.
 const merchant=values.FLUTTERWAVE_PAYOUT_MERCHANT_REF||values.FLUTTERWAVE_COLLECTION_MERCHANT_REF;
 if(!merchant||merchant!==env.VAYDU_PAYMENT_ACCOUNT_MERCHANT_REF)throw Error('setup_merchant_binding_incomplete');
 // Domain-separated server-only HMAC avoids storing bank numbers or requiring
 // another provider credential. Retain this private binding for reconciliation
 // if credentials are rotated; an old fingerprint is never silently replaced.
 const fingerprint=values.DRIVER_PAYOUT_FINGERPRINT_KEY||createHmac('sha256',values.FLUTTERWAVE_TEST_SECRET_KEY).update('vaydu/driver-beneficiary/fingerprint/v1').digest('hex');
 const provider=new FlutterwaveDriverPayout(values.FLUTTERWAVE_TEST_SECRET_KEY,fingerprint,request,undefined,false);
 return expected=>{if(expected!==merchant)throw Error('merchant_binding_mismatch');return provider;};
};
