import {createHmac} from 'node:crypto';
import type {Beneficiary,FrozenTransfer,TransferResult} from './flutterwave-driver-payout';

const unavailable=()=>new Error('Payment account provider unavailable. Please retry or contact support.');

/**
 * Kora beneficiary payout adapter (official Payout API, test mode only).
 *
 *   banks()             GET  /merchant/api/v1/misc/banks?countryCode=NG
 *   resolve()           POST /merchant/api/v1/misc/banks/resolve
 *   createBeneficiary() resolve + fingerprint freeze — Kora needs no
 *                       provider-side beneficiary object for single payouts;
 *                       the verified account IS the beneficiary identity.
 *   submit()            POST /merchant/api/v1/transactions/disburse
 *   lookup()            GET  /merchant/api/v1/transactions/{reference}
 *
 * Per Kora's own guidance a 5xx/network error is NEVER a definitive failure:
 * submit throws on any ambiguous outcome and the durable worker verifies via
 * lookup() before deciding. The submission marker commits before the POST, so
 * an accepted-but-lost response reconciles instead of re-submitting.
 *
 * Identity note (verified against the official docs): Kora assigns no
 * separate payout id. The merchant supplies `reference` (unique, >=5 chars)
 * and every response echoes it in `data.reference` — that echo, bound to our
 * frozen submission reference, is the settle identity. `trace_id` is Kora's
 * internal trace and is not used for settlement.
 *
 * Scope: NGN bank_account payouts only. No collections (that is KoraSandbox),
 * no bulk/remittance endpoints, no live keys, no mobile money.
 */
export class KoraDriverPayout {
 constructor(private key:string,private fingerprintKey:string,private request:typeof fetch=fetch,private allowTransfers=false){
  if(!/^sk_test_[A-Za-z0-9_-]+$/.test(key)||fingerprintKey.length<32)throw unavailable();
 }
 private async api(path:string,body?:Record<string,unknown>):Promise<any>{
  try{
   const response=await this.request('https://api.korapay.com/merchant/api/v1'+path,{
    method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
   if(response.status===404)return undefined;
   const json:any=await response.json().catch(()=>undefined);
   if(!response.ok||json?.status!==true||json.data===undefined)throw unavailable();
   return json.data;
  }catch{throw unavailable();}
 }
 fingerprint(bank:string,account:string){return createHmac('sha256',this.fingerprintKey).update(bank+':'+account).digest('hex');}
 async banks():Promise<Array<{code:string;name:string}>>{
  const data=await this.api('/misc/banks?countryCode=NG');
  if(!Array.isArray(data))throw unavailable();
  return data.filter(b=>/^\d{3,6}$/.test(String(b.code))&&typeof b.name==='string').map(b=>({code:String(b.code),name:b.name}));
 }
 async resolve(bank:string,account:string):Promise<string>{
  if(!/^\d{3,6}$/.test(bank)||!/^\d{10}$/.test(account))throw new Error('Check the bank and ten-digit account number.');
  const data=await this.api('/misc/banks/resolve',{bank,account,currency:'NG'});
  if(!data||data.account_number!==account||data.bank_code!==bank||typeof data.account_name!=='string'||!data.account_name.trim())throw unavailable();
  return data.account_name;
 }
 async createBeneficiary(bank:string,account:string,confirmedName?:string,beforeSubmit?:()=>Promise<void>,afterCreated?:(b:Beneficiary)=>Promise<void>):Promise<Beneficiary>{
  const name=await this.resolve(bank,account);
  if(confirmedName!==undefined&&confirmedName!==name)throw new Error('Account name changed. Check the account again.');
  // The durable fence sits immediately before the beneficiary is accepted —
  // symmetric with the Flutterwave adapter even though Kora has no creation POST.
  if(beforeSubmit)await beforeSubmit();
  const beneficiary={id:account,bank_code:bank,last4:account.slice(-4),fingerprint:this.fingerprint(bank,account)};
  if(afterCreated)await afterCreated(beneficiary);
  await this.verifyBeneficiary(beneficiary);return beneficiary;
 }
 async verifyBeneficiary(expected:Beneficiary):Promise<void>{await this.resolveVerified(expected);}
 // Re-resolves and re-fingerprints the frozen beneficiary, returning the
 // verified account name (Kora requires a customer object on disbursement).
 private async resolveVerified(expected:Beneficiary):Promise<string>{
  if(!/^\d{10}$/.test(expected.id))throw unavailable();
  const data=await this.api('/misc/banks/resolve',{bank:expected.bank_code,account:expected.id,currency:'NG'});
  if(!data||data.account_number!==expected.id||data.bank_code!==expected.bank_code
   ||this.fingerprint(data.bank_code,data.account_number)!==expected.fingerprint
   ||typeof data.account_name!=='string'||!data.account_name.trim())throw unavailable();
  return data.account_name.trim().slice(0,120);
 }
 private result(data:any,t:FrozenTransfer):TransferResult{
  // The query returns Kora's own reference; ours is echoed as the merchant
  // reference field. Either must bind before any state is trusted.
  // The query returns our merchant reference echoed in data.reference; a
  // record that does not carry it is not this transfer and stays unknown.
  const ours=data?.reference===t.reference||data?.merchant_reference===t.reference||data?.customer_reference===t.reference;
  if(!data||!ours||String(data.currency||'').toUpperCase()!==t.currency)return {state:'unknown'};
  const status=String(data.status||'').toLowerCase();
  // The echoed reference is the only provider-side identifier Kora returns —
  // it is what the settle RPC validates against the frozen submission marker.
  const id=String(data.reference||'');
  return {state:status==='success'?'completed':status==='failed'?'failed':'pending',
   id:id===t.reference?id:undefined,
   ...(/^(\d+)(\.\d+)?$/.test(String(data.fee))?{fee:String(data.fee)}:{})};
 }
 async lookup(t:FrozenTransfer):Promise<TransferResult|null>{
  if(t.currency!=='NGN'||!Number.isSafeInteger(t.amountMinor)||t.amountMinor<=0)throw unavailable();
  const data=await this.api('/transactions/'+encodeURIComponent(t.reference));
  if(data===undefined)return null;
  return this.result(data,t);
 }
 async submit(t:FrozenTransfer):Promise<void>{
  if(!this.allowTransfers)throw new Error('Driver payout transfers are disabled; account setup is verification-only.');
  if(t.currency!=='NGN'||!Number.isSafeInteger(t.amountMinor)||t.amountMinor<=0||!/^vaydu-[a-f0-9-]+_PMCK$/.test(t.reference))throw unavailable();
  const name=await this.resolveVerified(t.beneficiary);
  const amount=(t.amountMinor/100).toFixed(2);
  await this.api('/transactions/disburse',{reference:t.reference,destination:{type:'bank_account',amount:Number(amount),currency:'NGN',
   narration:'Vaydu driver earnings',bank_account:{bank:t.beneficiary.bank_code,account:t.beneficiary.id},customer:{name}}});
 }
}
