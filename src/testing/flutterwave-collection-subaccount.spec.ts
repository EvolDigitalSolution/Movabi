import {describe,it,expect} from 'vitest';
import {FlutterwaveCollectionSubaccount,type SubaccountInput} from '../../server/services/payments/flutterwave-collection-subaccount';
import {DriverCollectionAccountService} from '../../server/services/driver-collection-account.service';
const key='FLWSECK_TEST-synthetic',hmac='synthetic-key-for-fingerprints-32-characters';
const input:SubaccountInput={name:'Synthetic Driver',email:'driver@example.test',phone:'+2348000000000',accountType:'bank',bankCode:'044',accountNumber:'0123456789',confirmedName:'Synthetic Driver'};
function fixture(options:any={}){
 const calls:any[]=[];let created:any=null;
 const request:any=async(url:string,init:any)=>{
  const path=url.replace('https://api.flutterwave.com/v3','');const body=init.body?JSON.parse(init.body):null;calls.push({path,body});
  let data:any;
  if(path==='/banks/NG')data=[{id:9,code:'044',name:'Test Bank',has_branches:false}];
  else if(path==='/accounts/resolve')data={account_number:body.account_number,account_name:options.changedName?'Changed Name':'Synthetic Driver'};
  else if(path==='/subaccounts'&&body){
   created={...body,id:7,subaccount_id:'RS_SYNTHETIC',account_bank:body.is_f4b_account?'flutterwave':body.account_bank,split_value:0};
   if(options.timeout)throw Error('sensitive network details');data={id:7,subaccount_id:'RS_SYNTHETIC'};
  }else if(path.startsWith('/subaccounts?page=')){
   if(options.listError)return new Response(JSON.stringify({status:'error',message:options.listError.message,data:{private:'withheld'}}),{status:options.listError.status});
   data=options.rows??(created?[created]:[]);
   if(options.otherDestination&&data.length)data=[{...data[0],account_number:'9999999999'}];
   return new Response(JSON.stringify({status:'success',data,meta:{page_info:{total_pages:options.pages||1}}}));
  }else throw Error('Unexpected provider request');
  return new Response(JSON.stringify({status:'success',data}));
 };
 const provider=new FlutterwaveCollectionSubaccount(key,hmac,request);
 const terms={operationId:'11111111-1111-4111-8111-111111111111',requestHash:'a'.repeat(64),destinationHash:provider.destinationHash(input),last4:'6789',accountType:'bank' as const,defaultSplitType:'flat' as const,defaultSplitValue:'0.00'};
 return {provider,terms,calls,created:()=>created};
}
describe('v3 COLLECTION subaccount API',()=>{
 it('creates required contact/destination fields and verifies with the documented list endpoint',async()=>{const h=fixture();expect(await h.provider.create(input,h.terms)).toEqual({id:'RS_SYNTHETIC',numericId:'7',last4:'6789',verification:'retrieved'});const body=h.calls.find(c=>c.path==='/subaccounts').body;expect(body).toMatchObject({business_name:input.name,business_email:input.email,business_mobile:input.phone,country:'NG',currency:'NGN',account_bank:'044',split_type:'flat',split_value:0});expect(h.calls.some(c=>c.path==='/subaccounts?page=1')).toBe(true);expect(h.calls.some(c=>c.path.includes('beneficiar')||c.path.includes('transfer'))).toBe(false);});
 it('does not invent an active/charges/payouts flag when retrieval is the available proof',async()=>{const h=fixture();const result=await h.provider.create(input,h.terms);expect(result).not.toHaveProperty('payoutsEnabled');expect(result.verification).toBe('retrieved');});
 it('supports the documented F4B account shape only when called with that account type',async()=>{const h=fixture();const i={...input,accountType:'flutterwave' as const,accountNumber:'300000123',bankCode:''};const t={...h.terms,accountType:'flutterwave' as const,destinationHash:h.provider.destinationHash(i)};await h.provider.create(i,t);expect(h.calls.find(c=>c.path==='/subaccounts').body).toMatchObject({is_f4b_account:true,account_number:i.accountNumber});expect(h.calls.find(c=>c.path==='/subaccounts').body).not.toHaveProperty('account_bank');});
 it.each([{name:''},{email:'invalid'},{phone:'abc'},{accountNumber:'123'},{accountType:'virtual'}])('rejects invalid setup details %j',async bad=>{const h=fixture();await expect(h.provider.create({...input,...bad} as any,h.terms)).rejects.toThrow();expect(h.calls).toHaveLength(0);});
 it('suppresses sensitive errors after an uncertain create',async()=>{const h=fixture({timeout:true});await expect(h.provider.create(input,h.terms)).rejects.toThrow('Reconcile');expect(h.created()).not.toBeNull();expect(h.calls.filter(c=>c.path==='/subaccounts')).toHaveLength(1);});
 it('refuses a different retrieved destination',async()=>{const h=fixture({otherDestination:true});await expect(h.provider.create(input,h.terms)).rejects.toThrow();});
 it('does not attach another operation/driver account',async()=>{const h=fixture({rows:[{id:1,subaccount_id:'RS_OTHER',country:'NG',account_bank:'044',account_number:input.accountNumber,split_type:'flat',split_value:0,meta:[]}]});expect(await h.provider.reconcile(h.terms)).toBeNull();});
 it('rejects an ambiguous duplicate identity',async()=>{const h=fixture();await h.provider.create(input,h.terms);const row=h.created();await expect(fixture({rows:[row,row]}).provider.reconcile(h.terms)).rejects.toThrow();});
 it('recognises the actual merchant HTTP 400 empty list without treating it as unsupported',async()=>{const h=fixture({listError:{status:400,message:'Subaccounts not found'}});expect(await h.provider.reconcile(h.terms)).toBeNull();expect(h.calls.every(c=>!c.body)).toBe(true);});
 it.each([{status:401,message:'Subaccounts not found',category:'authentication'},{status:403,message:'Subaccounts not found',category:'permission'},{status:400,message:'Invalid authorization key',category:'authentication'},{status:400,message:'Permission denied',category:'permission'},{status:500,message:'Subaccounts not found',category:'technical'},{status:400,message:'Unexpected private text',category:'technical'}])('keeps non-empty-list failures distinct: %j',async error=>{const h=fixture({listError:error});await expect(h.provider.reconcile(h.terms)).rejects.toMatchObject({category:error.category});});
 it('does not complete creation until the new account is retrieved',async()=>{const h=fixture({listError:{status:400,message:'Subaccounts not found'}});await expect(h.provider.create(input,h.terms)).rejects.toThrow();expect(h.calls.filter(c=>c.body&&c.path==='/subaccounts')).toHaveLength(1);});
 it('rejects live credentials before any provider request',()=>expect(()=>new FlutterwaveCollectionSubaccount('FLWSECK-live',hmac)).toThrow());
});
function serviceFixture(options:any={}){
 const market={country_code:'NG',currency_code:'NGN',provider:'flutterwave',environment:'test',merchant_account_ref:'merchant',sandbox_driver_id:'driver',sandbox_tenant_id:'tenant',setup_approved:true,adapter_ready:true,capability_evidence_ref:'synthetic-evidence',default_split_type:'flat',default_split_value:'0',f4b_approved:false,...options.market};
 const h=fixture(options);let row:any=null,creates=0;const writes:any[]=[],filters:any[]=[];
 const original=h.provider.create.bind(h.provider);h.provider.create=async(...args)=>{creates++;return original(...args);};
 const db:any={from(table:string){let patch:any=null;const chain:any={select:()=>chain,eq:(k:any,v:any)=>{filters.push([table,k,v]);return chain;},neq:()=>chain,update:(p:any)=>{patch=p;return chain;},maybeSingle:async()=>({data:table==='driver_collection_markets'?market:row}),then:(resolve:any)=>{if(patch){writes.push(patch);Object.assign(row,patch);}return Promise.resolve({data:row?[{id:row.id}]:[]}).then(resolve);}};return chain;},rpc:async(_name:string,args:any)=>{
  if(row)return {data:[]};row={id:h.terms.operationId,driver_id:'driver',tenant_id:'tenant',environment:'test',merchant_account_ref:'merchant',state:'in_progress',
   request_hash:args.p_request_hash,destination_hash:args.p_destination_hash,account_type:args.p_account_type,last4:args.p_last4,default_split_type:'flat',default_split_value:'0'};return {data:[row]};}};
 const base:any={scope:async()=>({driverId:'driver',tenant:'tenant',country:options.country||'NG',currency:'NGN',market}),status:async()=>({provider:'stripe',state:'completed',available:true})};
 return {service:new DriverCollectionAccountService(db,base,()=>h.provider),creates:()=>creates,writes,filters,row:()=>row,provider:h.provider};
}
describe('durable subaccount setup, isolated from beneficiaries',()=>{
 it('opens first-time setup without any existing subaccount or list request',async()=>{const h=serviceFixture({listError:{status:400,message:'Subaccounts not found'}});expect(await h.service.status('driver')).toMatchObject({state:'not_started',available:true,reconcileOnly:false});expect(h.creates()).toBe(0);expect(h.row()).toBeNull();});
 it('empty HTTP 400 after timeout remains reconciliation-only across refresh and repeated submits',async()=>{const h=serviceFixture({timeout:true,listError:{status:400,message:'Subaccounts not found'}});await expect(h.service.setup('driver',input)).rejects.toThrow('uncertain');for(let i=0;i<2;i++){expect(await h.service.reconcile('driver')).toMatchObject({state:'action_required',reconcileOnly:true});expect(await h.service.setup('driver',input)).toMatchObject({state:'action_required',reconcileOnly:true});}expect(await h.service.status('driver')).toMatchObject({state:'action_required',reconcileOnly:true});expect(h.creates()).toBe(1);expect(h.row().subaccount_id).toBeUndefined();});
 it('persists only references/fingerprints and completes after retrieval',async()=>{const h=serviceFixture();expect(await h.service.setup('driver',input)).toMatchObject({state:'completed',purpose:'collection_subaccount',last4:'6789'});expect(JSON.stringify(h.row())).not.toContain(input.accountNumber);expect(JSON.stringify(h.writes)).not.toContain(input.email);expect(h.creates()).toBe(1);});
 it('concurrent setup has one create claim',async()=>{const h=serviceFixture();await Promise.allSettled([h.service.setup('driver',input),h.service.setup('driver',input)]);expect(h.creates()).toBe(1);});
 it('timeout recovery finds the created subaccount without another POST',async()=>{const h=serviceFixture({timeout:true});await expect(h.service.setup('driver',input)).rejects.toThrow('uncertain');expect(h.row().state).toBe('action_required');expect(await h.service.reconcile('driver')).toMatchObject({state:'completed'});expect(h.creates()).toBe(1);});
 it('a repeated submit after timeout performs reconciliation, never create',async()=>{const h=serviceFixture({timeout:true});await h.service.setup('driver',input).catch(()=>{});await h.service.setup('driver',{...input,name:'Changed Name'});expect(h.creates()).toBe(1);});
 it('account confirmation mismatch makes no durable claim or create',async()=>{const h=serviceFixture({changedName:true});await expect(h.service.setup('driver',input)).rejects.toThrow('confirm');expect(h.row()).toBeNull();expect(h.creates()).toBe(0);});
 it.each([{sandbox_driver_id:'other'},{sandbox_tenant_id:'other'},{environment:'live'},{setup_approved:false},{provider:'kora'}])('blocks another unapproved scope %j',async market=>{const h=serviceFixture({market});expect(await h.service.status('driver')).toMatchObject({state:'unavailable'});await expect(h.service.setup('driver',input)).rejects.toThrow();expect(h.creates()).toBe(0);});
 it('does not enable F4B from the dashboard option alone',async()=>{const h=serviceFixture();await expect(h.service.setup('driver',{...input,accountType:'flutterwave',accountNumber:'300000123'})).rejects.toThrow('not approved');});
 it('filters records by authenticated driver, tenant, merchant and test environment',async()=>{const h=serviceFixture();await h.service.status('driver');for(const pair of [['driver_id','driver'],['tenant_id','tenant'],['merchant_account_ref','merchant'],['environment','test']])expect(h.filters).toContainEqual(['driver_collection_subaccounts',...pair]);});
});
