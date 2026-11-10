/** Read-only readiness. Never creates an attempt, contacts a provider, or enables collection. */
export class WalletTopupReadinessError extends Error {
 status:number; code:string;
 constructor(status:number, code:string) { super(code); this.status=status; this.code=code; }
}
const unavailable=()=>new WalletTopupReadinessError(503,'WALLET_TOPUP_READINESS_UNAVAILABLE');
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeCurrency=(v:any)=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)?v:null;
const city=(v:any)=>typeof v==='string'?v.trim().replace(/\s+/g,' ').toLowerCase():'';
export async function customerWalletTopupReadiness(db:any,owner:string,now=Date.now()):Promise<any>{
 if(!uuid(owner))throw new WalletTopupReadinessError(401,'AUTH_REQUIRED');
 const read=async(q:any)=>{const r=await q;if(r.error)throw unavailable();return r.data;};
 const profile=await read(db.from('profiles').select('id,role,tenant_id,registration_country_code,registration_market_city,registration_activated_at').eq('id',owner).maybeSingle());
 const base={collectionAvailable:false,implementation:'readiness_only',canSubmit:false};
 const result=(reason:string,fields:any={})=>({...base,reason,...fields});
 if(!object(profile)||profile.id!==owner||profile.role!=='customer'||!uuid(profile.tenant_id)
 ||!profile.registration_activated_at||!Number.isFinite(Date.parse(profile.registration_activated_at))||Date.parse(profile.registration_activated_at)>now
 ||typeof profile.registration_country_code!=='string'||!/^[A-Z]{2}$/.test(profile.registration_country_code))
  return result('registration_not_ready');
 const country=profile.registration_country_code;
 const rows=await read(db.from('market_availability').select('country_code,supported_currency,enabled,launch_status,customer_app_enabled,market_city,zone_id,valid_from,valid_until').eq('country_code',country));
 if(!Array.isArray(rows))throw unavailable();
 const current=(r:any)=>{
  if(!object(r)||r.country_code!==country||r.enabled!==true||r.zone_id!=null&&String(r.zone_id).trim()!=='')return false;
  for(const key of ['valid_from','valid_until'])if(r[key]!=null&&r[key]!==''&&!Number.isFinite(Date.parse(r[key])))throw unavailable();
  return (!r.valid_from||Date.parse(r.valid_from)<=now)&&(!r.valid_until||Date.parse(r.valid_until)>now);
 };
 const scoped=rows.filter(current);const c=city(profile.registration_market_city);
 const matches=c?scoped.filter((r:any)=>city(r.market_city)===c):[];
 const markets=matches.length?matches:scoped.filter((r:any)=>city(r.market_city)==='');
 if(markets.length!==1||markets[0].launch_status!=='live'||markets[0].customer_app_enabled!==true||!safeCurrency(markets[0].supported_currency))return result('market_unavailable',{country});
 const currency=markets[0].supported_currency;
 const wallet=await read(db.from('wallets').select('id,user_id,currency_code').eq('user_id',owner).maybeSingle());
 if(!wallet)return result('wallet_not_set_up',{country,currency});
 if(!object(wallet)||wallet.user_id!==owner||!uuid(wallet.id)||!safeCurrency(wallet.currency_code))throw unavailable();
 if(wallet.currency_code!==currency)return result('wallet_currency_mismatch',{country,currency,walletCurrency:wallet.currency_code});
 const config=await read(db.from('wallet_collection_config').select('key,value').in('key',['enabled','max_amount_minor_'+currency]));
 const routes=await read(db.from('market_payment_routes').select('country_code,currency_code,provider,method,preferred,enabled,merchant_approved,adapter_ready,capabilities,merchant_account_ref').eq('country_code',country).eq('currency_code',currency).eq('method','card'));
 if(!Array.isArray(config)||!Array.isArray(routes))throw unavailable();
 const value=(k:string)=>{const r=config.filter((x:any)=>object(x)&&x.key===k);if(r.length>1)throw unavailable();return r[0]?.value;};
 const enabled=value('enabled')==='true',limit=value('max_amount_minor_'+currency);
 const validLimit=typeof limit==='string'&&/^[1-9][0-9]{0,18}$/.test(limit)&&BigInt(limit)<=9223372036854775807n;
 const options=routes.map((r:any)=>{
  if(!object(r)||r.country_code!==country||r.currency_code!==currency||r.method!=='card')throw unavailable();
  if(!['stripe','kora','fincra'].includes(r.provider))return null;
  const reasons:string[]=[];
  if(r.preferred!==true)reasons.push('not_preferred');
  if(r.enabled!==true)reasons.push('route_disabled');
  if(r.merchant_approved!==true)reasons.push('merchant_not_approved');
  if(r.adapter_ready!==true)reasons.push('adapter_not_ready');
  if(typeof r.merchant_account_ref!=='string'||!r.merchant_account_ref.trim())reasons.push('merchant_reference_missing');
  if(!Array.isArray(r.capabilities)||!r.capabilities.includes('collect'))reasons.push('collection_capability_missing');
  return {provider:r.provider,routeReady:reasons.length===0,reasons};
 }).filter(Boolean);
 const eligible=options.filter((x:any)=>x.routeReady).length;
 const blockers:string[]=[];
 if(!enabled)blockers.push('collection_disabled');
 if(!validLimit)blockers.push('currency_limit_missing_or_invalid');
 if(eligible!==1)blockers.push(eligible===0?'no_eligible_collection_route':'ambiguous_collection_routes');
 // This batch has no collection transport/HTTP writer. Never advertise spendable deposits.
 blockers.push('collection_integration_pending');
 return result(blockers[0],{country,currency,collectionEnabled:enabled,maxAmountMinor:validLimit?limit:null,providers:options,blockers});
}
