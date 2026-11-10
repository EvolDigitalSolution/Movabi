/** Empty wallet provisioning only. No country/amount/provider is accepted from the caller. */
export function customerWalletSetupError(error:unknown):{status:number;code:string;error:string}|null {
 const errors:Record<string,{status:number;code:string;error:string}>={
  WH001:{status:409,code:'CUSTOMER_WALLET_NOT_READY',error:'Complete customer registration before setting up a wallet.'},
  WH002:{status:409,code:'CUSTOMER_WALLET_MARKET_UNAVAILABLE',error:'Wallet setup is unavailable for the registered market.'},
  WH004:{status:409,code:'CUSTOMER_WALLET_SETUP_DISABLED',error:'Customer wallet setup is not enabled yet.'},
  WH005:{status:403,code:'CUSTOMER_WALLET_NOT_ALLOWED',error:'This wallet setup request is not allowed.'}
 };
 const code=String((error as any)?.code||'');return Object.prototype.hasOwnProperty.call(errors,code)?{...errors[code]}:null;
}
export async function ensureCustomerWallet(db:any,owner:string):Promise<any> {
 const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
 if(!uuid(owner))throw Object.assign(new Error('Customer identity required'),{code:'WH001'});
 const {data,error}=await db.rpc('ensure_customer_wallet_v1h',{p_user_id:owner});
 if(error)throw error;
 const w=data?.wallet;
 const amount=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,39})(\.[0-9]{1,40})?$/.test(v);
 if(!data||!['created','existing'].includes(data.status)||!w||w.user_id!==owner||!uuid(w.id)
 ||typeof w.currency_code!=='string'||!(/^[A-Z]{3}$/).test(w.currency_code)
 ||typeof data.currency!=='string'||!(/^[A-Z]{3}$/).test(data.currency)
 ||typeof data.country!=='string'||!(/^[A-Z]{2}$/).test(data.country)
 ||typeof data.currencyMatchesMarket!=='boolean'||data.currencyMatchesMarket!==(w.currency_code===data.currency)
 ||!amount(w.available_balance)||!amount(w.reserved_balance))throw Error('Wallet setup response unavailable');
 if(data.status==='created'&&(!/^0(?:\.0+)?$/.test(w.available_balance)||!/^0(?:\.0+)?$/.test(w.reserved_balance)||!data.currencyMatchesMarket))
  throw Error('Wallet setup must start empty in its configured currency');
 return {status:data.status,country:data.country,currency:data.currency,currencyMatchesMarket:data.currencyMatchesMarket,
  wallet:{id:w.id,user_id:owner,currency_code:w.currency_code,available_balance:w.available_balance,reserved_balance:w.reserved_balance,
   created_at:w.created_at,updated_at:w.updated_at}};
}
