import {createHmac} from 'node:crypto';
import {FlutterwaveDriverPayout} from './flutterwave-driver-payout';

export interface SubaccountInput {
 name:string;email:string;phone:string;accountType:'bank'|'flutterwave';bankCode:string;accountNumber:string;confirmedName:string;
}
export interface SubaccountTerms {
 operationId:string;requestHash:string;destinationHash:string;accountType:'bank'|'flutterwave';last4:string;
 defaultSplitType:'flat'|'percentage';defaultSplitValue:string;
}
export interface CollectionSubaccount {id:string;numericId:string;last4:string;verification:'retrieved';}
export class SubaccountListError extends Error {
 constructor(public category:'authentication'|'permission'|'technical'){super('Collection account list could not be checked ('+category+'). Retry reconciliation only.');}
}
const fail=()=>new Error('Collection payment account could not be verified. Reconcile this setup before retrying.');
/** Collection subaccounts, NOT payout beneficiaries or virtual accounts. v3 test only. */
export class FlutterwaveCollectionSubaccount {
 private bank:FlutterwaveDriverPayout;
 constructor(private secret:string,private hashKey:string,private request:typeof fetch=fetch){
  if(!/^FLWSECK_TEST-[A-Za-z0-9_-]+$/.test(secret)||hashKey.length<32)throw fail();
  this.bank=new FlutterwaveDriverPayout(secret,hashKey,request);
 }
 hash(value:string){return createHmac('sha256',this.hashKey).update(value).digest('hex');}
 async call(path:string,body?:Record<string,unknown>):Promise<any>{
  try{
   const response=await this.request('https://api.flutterwave.com/v3'+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+this.secret,'Content-Type':'application/json'},body:body?JSON.stringify(body).replace(/"split_value":"(\d+(?:\.\d+)?)"/, '"split_value":$1'):undefined});
   const raw=await response.text();
   const json=JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(m,s)=>s||JSON.stringify(m)));
   const listRead=!body&&/^\/subaccounts\?page=\d+$/.test(path);
   // This merchant returns HTTP 400 for an empty collection list. Never apply to POSTs,
   // authentication/permission statuses, or arbitrary 'not found' technical errors.
   const message=typeof json.message==='string'?json.message.trim().toLowerCase().replace(/[.!]+$/,''):'';
   if(listRead&&response.status===400&&['subaccounts not found','no subaccounts found','no subaccount found','no subaccounts available'].includes(message))
    return {status:'success',data:[],meta:{page_info:{total_pages:'0'}},emptyList:true};
   if(!response.ok||json.status!=='success'){
    if(listRead)throw new SubaccountListError(response.status===401||['invalid authorization key','invalid secret key','unauthorized'].includes(message)?'authentication':response.status===403||['access denied','permission denied','forbidden'].includes(message)?'permission':'technical');
    throw fail();
   }return json;
  }catch(error){if(error instanceof SubaccountListError)throw error;if(!body&&/^\/subaccounts\?page=\d+$/.test(path))throw new SubaccountListError('technical');throw fail();}
 }
 banks(){return this.bank.banks();}
 validate(input:SubaccountInput){
  if(!input||!['bank','flutterwave'].includes(input.accountType)||typeof input.name!=='string'||input.name.trim().length<2||input.name.length>120
   ||!/^\S+@\S+\.\S+$/.test(input.email)||input.email.length>180||!/^\+?[0-9]{8,15}$/.test(input.phone))throw new Error('Check the required name, email and phone details.');
  if(input.accountType==='bank'?(!/^\d{3,6}$/.test(input.bankCode)||!/^\d{10}$/.test(input.accountNumber)):!/^\d{6,20}$/.test(input.accountNumber))throw new Error('Check the payment account details.');
 }
 async resolve(accountType:string,bankCode:string,accountNumber:string){
  if(accountType==='bank')return this.bank.resolve(bankCode,accountNumber);
  if(accountType!=='flutterwave'||!/^\d{6,20}$/.test(accountNumber))throw fail();
  const {data}=await this.call('/accounts/resolve',{account_bank:'flutterwave',account_number:accountNumber});
  if(data?.account_number!==accountNumber||typeof data.account_name!=='string'||!data.account_name.trim())throw fail();return data.account_name;
 }
 destinationHash(input:SubaccountInput){return this.hash(`${input.accountType}:${input.accountType==='bank'?input.bankCode:'flutterwave'}:${input.accountNumber}`);}
 private decimal(value:unknown){const s=String(value);if(!/^\d+(?:\.\d+)?$/.test(s))return null;const [whole,fraction='']=s.split('.');const f=fraction.replace(/0+$/,'');return whole.replace(/^0+(?=\d)/,'')+(f?'.'+f:'');}
 private match(data:any,t:SubaccountTerms):boolean{
  const meta=Array.isArray(data?.meta)?data.meta:[];
  const value=(name:string)=>meta.find((m:any)=>m.meta_name===name)?.meta_value;
  return !!data&&/^RS_[A-Za-z0-9]+$/.test(String(data.subaccount_id))&&/^\d+$/.test(String(data.id))
   && data.country==='NG'&&(data.currency===undefined||data.currency==='NGN')
   && this.hash(`${t.accountType}:${data.account_bank}:${data.account_number}`)===t.destinationHash
   &&value('vaydu_operation')===t.operationId&&value('vaydu_request')===t.requestHash
   &&data.split_type===t.defaultSplitType&&this.decimal(data.split_value)===this.decimal(t.defaultSplitValue)
   &&data.is_active!==false&&!['inactive','disabled','deleted','suspended'].includes(String(data.status||'').toLowerCase());
 }
 /** Documented paginated list is the retrieval authority; never invent a GET-one API/status. */
 async reconcile(t:SubaccountTerms):Promise<CollectionSubaccount|null>{
  let found:any=null;
  for(let page=1;page<=50;page++){
   const json=await this.call('/subaccounts?page='+page);
   if(!Array.isArray(json.data))throw fail();
   for(const row of json.data){
    if(this.match(row,t)){if(found)throw fail();found=row;}
   }
   const pages=Number(json.meta?.page_info?.total_pages);
   if(json.emptyList===true||pages===0&&page===1&&!json.data.length)return found?{id:found.subaccount_id,numericId:String(found.id),last4:t.last4,verification:'retrieved'}:null;
   if(!Number.isSafeInteger(pages)||pages<1||pages>50)throw fail();
   if(page===pages)return found?{id:found.subaccount_id,numericId:String(found.id),last4:t.last4,verification:'retrieved'}:null;
  }
  throw fail();
 }
 async create(input:SubaccountInput,t:SubaccountTerms):Promise<CollectionSubaccount>{
  this.validate(input);
  if(!['flat','percentage'].includes(t.defaultSplitType)||!/^\d+(?:\.\d+)?$/.test(t.defaultSplitValue)
   ||(t.defaultSplitType==='percentage'&&Number(t.defaultSplitValue)>1)||this.destinationHash(input)!==t.destinationHash)throw fail();
  // The default is an explicitly configured administrative value, never a booking commission.
  const body:any={account_number:input.accountNumber,business_name:input.name.trim(),business_email:input.email.trim(),business_mobile:input.phone,
   business_contact:input.name.trim(),business_contact_mobile:input.phone,country:'NG',currency:'NGN',split_type:t.defaultSplitType,split_value:t.defaultSplitValue,
   meta:[{meta_name:'vaydu_operation',meta_value:t.operationId},{meta_name:'vaydu_request',meta_value:t.requestHash}]};
  if(input.accountType==='flutterwave')body.is_f4b_account=true;else body.account_bank=input.bankCode;
  const {data}=await this.call('/subaccounts',body);
  if(!/^RS_[A-Za-z0-9]+$/.test(String(data?.subaccount_id))||!/^\d+$/.test(String(data?.id)))throw fail();
  const verified=await this.reconcile(t);
  if(!verified||verified.id!==data.subaccount_id)throw fail();return verified;
 }
}

export function sandboxSubaccountProvider(expectedMerchant?:string){
 if(!['test','development'].includes(process.env.NODE_ENV||'')||process.env.VAYDU_DEPLOYMENT_ENV!=='develop'
  ||process.env.VAYDU_DRIVER_SUBACCOUNT_SANDBOX!=='true')throw new Error('Collection subaccount sandbox is disabled.');
 if(process.env.FLUTTERWAVE_LIVE_SECRET_KEY||(process.env.FLUTTERWAVE_SECRET_KEY&&!process.env.FLUTTERWAVE_SECRET_KEY.startsWith('FLWSECK_TEST-')))throw new Error('Live Flutterwave credentials forbidden in sandbox.');
 const target=new URL(process.env.SUPABASE_URL||'');
 if(!['http://movabi-develop-kong:8000/','https://movabi-supabase-develop.apps.evolsolution.com/'].includes(target.href))throw new Error('Verified develop target required.');
 const merchant=process.env.FLUTTERWAVE_COLLECTION_MERCHANT_REF;
 if(!merchant||(expectedMerchant&&expectedMerchant!==merchant))throw new Error('Approved collection merchant binding required.');
 return new FlutterwaveCollectionSubaccount(process.env.FLUTTERWAVE_TEST_SECRET_KEY||'',process.env.DRIVER_SUBACCOUNT_FINGERPRINT_KEY||process.env.DRIVER_PAYOUT_FINGERPRINT_KEY||'');
}
